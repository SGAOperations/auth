import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

// Database side of the Primary Admin transfer: executes a COOLING transfer
// whose window has ended, and expires a PENDING_ACCEPTANCE one nobody accepted.
// Initiate, accept and cancel belong to the transfer service (#49).
//
// Concurrency: each transfer is claimed with FOR UPDATE SKIP LOCKED inside its
// own transaction, and everything is decided while that lock is held. A second
// run either skips the row or, once the first commits, no longer matches the
// status it selects on, so a transfer is acted on once.

/** Caps one run; the one-in-flight index means one pending row is the norm. */
const MAX_PER_RUN = 5;

export type TransferNotice = {
  kind: "completed" | "cancelled" | "expired";
  transferId: string;
  fromUserId: string;
  toUserId: string;
  reason?: string;
};

/** Called after the state change commits. #49 supplies the email version. */
export type TransferNotifier = (notice: TransferNotice) => Promise<void> | void;

type Tx = Prisma.TransactionClient;

type ClaimedTransfer = Prisma.PrimaryAdminTransferGetPayload<{
  include: { fromUser: true; toUser: true };
}>;

/**
 * Test seams. They default to nothing and production never passes them. The
 * harness cannot commit a Primary Admin (src/test/db-setup.ts), so a test
 * creates one inside the transaction under test and inspects it before the
 * rollback.
 */
export interface PaTransferHooks {
  /** After the row is claimed and read, before eligibility is checked. */
  afterClaim?: (tx: Tx, transfer: ClaimedTransfer) => Promise<void>;
  /** After every write, immediately before the transaction commits. */
  beforeCommit?: (tx: Tx) => Promise<void>;
}

export interface PaTransferOptions {
  now?: Date;
  notify?: TransferNotifier;
  hooks?: PaTransferHooks;
}

// A type alias, not an interface, so it is assignable to a job's result record.
export type PaTransferResult = {
  executed: number;
  cancelled: number;
  expired: number;
  notifyFailures: number;
};

const logOnlyNotifier: TransferNotifier = (notice) => {
  logger.info("pa_transfer.notification_pending", { ...notice });
};

const SYSTEM = { actorType: "SYSTEM" } as const;

async function claimDueCooling(tx: Tx, now: Date) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PrimaryAdminTransfer"
    WHERE "status" = 'COOLING' AND "executesAt" <= ${now}
    ORDER BY "executesAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
  return rows[0] ? readTransfer(tx, rows[0].id) : null;
}

async function claimStalePending(tx: Tx, now: Date) {
  const rows = await tx.$queryRaw<{ id: string }[]>`
    SELECT "id" FROM "PrimaryAdminTransfer"
    WHERE "status" = 'PENDING_ACCEPTANCE' AND "acceptanceExpiresAt" <= ${now}
    ORDER BY "acceptanceExpiresAt" LIMIT 1 FOR UPDATE SKIP LOCKED`;
  return rows[0] ? readTransfer(tx, rows[0].id) : null;
}

function readTransfer(tx: Tx, id: string) {
  return tx.primaryAdminTransfer.findUniqueOrThrow({
    where: { id },
    include: { fromUser: true, toUser: true },
  });
}

function noticeFor(
  kind: TransferNotice["kind"],
  transfer: ClaimedTransfer,
  reason?: string,
): TransferNotice {
  return {
    kind,
    transferId: transfer.id,
    fromUserId: transfer.fromUserId,
    toUserId: transfer.toUserId,
    ...(reason ? { reason } : {}),
  };
}

async function cancelIneligible(
  tx: Tx,
  transfer: ClaimedTransfer,
  now: Date,
  reason: string,
): Promise<TransferNotice> {
  await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledById: null,
      reason,
    },
  });
  await writeAuditEvent(tx, {
    type: "PA_TRANSFER_CANCELLED",
    ...SYSTEM,
    targetType: "TRANSFER",
    targetId: transfer.id,
  });
  return noticeFor("cancelled", transfer, reason);
}

async function execute(
  tx: Tx,
  transfer: ClaimedTransfer,
  now: Date,
): Promise<TransferNotice> {
  // Transaction-local, never a plain SET: see the primary_admin_invariants
  // migration header (a session-level SET leaks through the pooler).
  await tx.$executeRaw`SET LOCAL sgauth.pa_transfer = 'on'`;
  // Clear the sender first: the unique index cannot be deferred.
  await tx.user.update({
    where: { id: transfer.fromUserId },
    data: { isPrimaryAdmin: false },
  });
  await tx.user.update({
    where: { id: transfer.toUserId },
    data: { isPrimaryAdmin: true },
  });
  // Sessions live only in the database (no cookie cache), so deleting them
  // forces both users to sign in again with their new standing.
  await tx.session.deleteMany({
    where: { userId: { in: [transfer.fromUserId, transfer.toUserId] } },
  });
  await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: { status: "COMPLETED", completedAt: now },
  });
  await writeAuditEvent(tx, {
    type: "PA_TRANSFER_COMPLETED",
    ...SYSTEM,
    targetType: "TRANSFER",
    targetId: transfer.id,
  });
  return noticeFor("completed", transfer);
}

async function expire(
  tx: Tx,
  transfer: ClaimedTransfer,
): Promise<TransferNotice> {
  await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: { status: "EXPIRED" },
  });
  await writeAuditEvent(tx, {
    type: "PA_TRANSFER_EXPIRED",
    ...SYSTEM,
    targetType: "TRANSFER",
    targetId: transfer.id,
  });
  return noticeFor("expired", transfer);
}

async function processOne(
  tx: Tx,
  now: Date,
  hooks: PaTransferHooks,
): Promise<TransferNotice | null> {
  const due = await claimDueCooling(tx, now);
  if (due) {
    await hooks.afterClaim?.(tx, due);
    // Re-read inside the lock: the parties may have changed during cooling.
    const { fromUser, toUser } = await readTransfer(tx, due.id);
    let notice: TransferNotice;
    if (toUser.status !== "ACTIVE" || !toUser.isAdmin) {
      notice = await cancelIneligible(tx, due, now, "recipient_ineligible");
    } else if (!fromUser.isPrimaryAdmin) {
      notice = await cancelIneligible(tx, due, now, "sender_not_primary_admin");
    } else {
      notice = await execute(tx, due, now);
    }
    await hooks.beforeCommit?.(tx);
    return notice;
  }

  const stale = await claimStalePending(tx, now);
  if (!stale) return null;
  await hooks.afterClaim?.(tx, stale);
  const notice = await expire(tx, stale);
  await hooks.beforeCommit?.(tx);
  return notice;
}

export async function runPaTransferJob(
  options: PaTransferOptions = {},
): Promise<PaTransferResult> {
  const now = options.now ?? new Date();
  const notify = options.notify ?? logOnlyNotifier;
  const hooks = options.hooks ?? {};
  const result: PaTransferResult = {
    executed: 0,
    cancelled: 0,
    expired: 0,
    notifyFailures: 0,
  };

  for (let i = 0; i < MAX_PER_RUN; i += 1) {
    const notice = await prisma.$transaction((tx) =>
      processOne(tx, now, hooks),
    );
    if (!notice) break;

    if (notice.kind === "completed") result.executed += 1;
    else if (notice.kind === "cancelled") result.cancelled += 1;
    else result.expired += 1;

    // The state change has committed, so a failing notifier is counted and
    // logged, never rethrown.
    try {
      await notify(notice);
    } catch (err) {
      result.notifyFailures += 1;
      logger.error("pa_transfer.notify_failed", {
        err,
        transferId: notice.transferId,
        kind: notice.kind,
      });
    }
  }

  return result;
}
