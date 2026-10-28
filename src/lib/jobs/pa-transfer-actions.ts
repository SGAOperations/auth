import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { z } from "zod";
import type {
  PrimaryAdminTransfer,
  PrismaClient,
} from "@/generated/prisma/client";
import { audit, type TransferCancelReason } from "@/lib/audit";
import {
  can,
  canActOnTransfer,
  type AuthzDenialReason,
  type AuthzSubject,
} from "@/lib/authz";
import {
  lockTransfer,
  noticeFor,
  type Tx,
  type TransferNotice,
} from "@/lib/jobs/pa-transfer";
import {
  ACCEPTANCE_WINDOW_MS,
  COOLING_MS,
  checkTransition,
  recipientIneligibility,
  type RecipientIneligibility,
  type TransferEvent,
} from "@/lib/jobs/pa-transfer-machine";
import {
  TOKEN_ACTION_RESULTS,
  type TokenActionResult,
} from "@/lib/token-links/handler";
import { displayName } from "@/lib/user-display";

// The user-driven half of the Primary Admin transfer state machine:
// initiate, accept, decline, cancel, and cancel by the emailed token. The legal
// moves are pa-transfer-machine.ts; who may make them is authz.ts. Execute,
// expire and the ineligible-recipient cancel belong to the scheduled job.
//
// Every transition is `fn(tx, input, now)`: it runs in a transaction its caller
// opens, writes its own audit row in that transaction, and returns the notice
// to send once the transaction has committed. Nothing here sends mail.

export type TransferErrorCode =
  | "TRANSFER_NOT_FOUND"
  | "TRANSFER_INVALID_STATE"
  | "TRANSFER_IN_FLIGHT"
  | "CONFIRM_EMAIL_MISMATCH"
  | "RECIPIENT_INELIGIBLE";

export class TransferError extends Error {
  readonly code: TransferErrorCode | AuthzDenialReason;
  /** Set on RECIPIENT_INELIGIBLE: which rule the recipient failed. */
  readonly reason?: RecipientIneligibility;

  constructor(
    code: TransferErrorCode | AuthzDenialReason,
    reason?: RecipientIneligibility,
  ) {
    super(code);
    this.name = "TransferError";
    this.code = code;
    this.reason = reason;
  }
}

export interface TransitionResult {
  transfer: PrimaryAdminTransfer;
  notice: TransferNotice;
}

const IN_FLIGHT = ["PENDING_ACCEPTANCE", "COOLING"] as const;

/** Lower-case hex SHA-256: the only form of a cancel token that is stored. */
export function hashCancelToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

const actorSelect = {
  id: true,
  isAdmin: true,
  isPrimaryAdmin: true,
  status: true,
  twoFactorEnabled: true,
} as const;

/** The actor's row, read again inside the transfer's lock. */
async function currentActor(tx: Tx, actorId: string) {
  const actor = await tx.user.findUnique({
    where: { id: actorId },
    select: actorSelect,
  });
  // The caller just resolved this id from a session; a missing row is a race
  // with deletion, and users are never deleted.
  if (!actor) throw new TransferError("ACTOR_INACTIVE");
  return actor;
}

type IdAction = "accept" | "decline" | "cancel";

/**
 * The shared front of accept, decline and cancel: lock the row, then check
 * that it exists, that the actor may act on it, and that its state allows the
 * event. Returns the row as read under the lock.
 */
async function loadForAction(
  tx: Tx,
  transferId: string,
  actorId: string,
  action: IdAction,
  now: Date,
) {
  await lockTransfer(tx, transferId);
  const transfer = await tx.primaryAdminTransfer.findUnique({
    where: { id: transferId },
  });
  if (!transfer) throw new TransferError("TRANSFER_NOT_FOUND");

  const actor = await currentActor(tx, actorId);
  const decision = canActOnTransfer(actor, transfer, action);
  if (!decision.allowed) throw new TransferError(decision.reason);

  const event: TransferEvent = action;
  if (!checkTransition(transfer, event, now).ok) {
    throw new TransferError("TRANSFER_INVALID_STATE");
  }
  return { transfer, actor };
}

export interface InitiateInput {
  actor: AuthzSubject;
  recipientUserId: string;
  /** What the Primary Admin typed; it must equal the recipient's email. */
  confirmEmail: string;
}

export async function initiateTransfer(
  tx: Tx,
  { actor, recipientUserId, confirmEmail }: InitiateInput,
  now: Date,
): Promise<TransitionResult> {
  const recipient = await tx.user.findUnique({
    where: { id: recipientUserId },
    select: { ...actorSelect, email: true },
  });
  if (!recipient) throw new TransferError("RECIPIENT_INELIGIBLE", "NOT_ADMIN");

  const decision = can(actor, "initiateTransfer", recipient);
  if (!decision.allowed) throw new TransferError(decision.reason);

  // `can()` does not look at MFA; the recipient must be able to act as Primary Admin.
  const ineligible = recipientIneligibility(recipient, actor.id);
  if (ineligible) throw new TransferError("RECIPIENT_INELIGIBLE", ineligible);

  if (confirmEmail.trim() !== recipient.email) {
    throw new TransferError("CONFIRM_EMAIL_MISMATCH");
  }

  const inFlight = await tx.primaryAdminTransfer.findFirst({
    where: { status: { in: [...IN_FLIGHT] } },
    select: { id: true },
  });
  if (inFlight) throw new TransferError("TRANSFER_IN_FLIGHT");

  // Set here, not left to the column default, so a fake clock drives it.
  const transfer = await tx.primaryAdminTransfer.create({
    data: {
      fromUserId: actor.id,
      toUserId: recipient.id,
      acceptanceExpiresAt: new Date(now.getTime() + ACCEPTANCE_WINDOW_MS),
    },
  });
  await audit(
    {
      type: "PA_TRANSFER_INITIATED",
      actorType: "USER",
      actorUserId: actor.id,
      targetType: "TRANSFER",
      targetId: transfer.id,
    },
    { db: tx },
  );
  return { transfer, notice: noticeFor("initiated", transfer) };
}

export async function acceptTransfer(
  tx: Tx,
  input: { transferId: string; actorId: string },
  now: Date,
): Promise<TransitionResult> {
  const { transfer, actor } = await loadForAction(
    tx,
    input.transferId,
    input.actorId,
    "accept",
    now,
  );
  // The recipient may have lost admin or MFA since the transfer was started.
  const ineligible = recipientIneligibility(actor, transfer.fromUserId);
  if (ineligible) throw new TransferError("RECIPIENT_INELIGIBLE", ineligible);

  const cancelToken = randomBytes(32).toString("base64url");
  const updated = await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "COOLING",
      acceptedAt: now,
      executesAt: new Date(now.getTime() + COOLING_MS),
      cancelTokenHash: hashCancelToken(cancelToken),
    },
  });
  await audit(
    {
      type: "PA_TRANSFER_ACCEPTED",
      actorType: "USER",
      actorUserId: actor.id,
      targetType: "TRANSFER",
      targetId: transfer.id,
    },
    { db: tx },
  );
  return {
    transfer: updated,
    notice: noticeFor("accepted", updated, { cancelToken }),
  };
}

async function cancelByPerson(
  tx: Tx,
  input: { transferId: string; actorId: string },
  action: "decline" | "cancel",
  now: Date,
): Promise<TransitionResult> {
  const { transfer, actor } = await loadForAction(
    tx,
    input.transferId,
    input.actorId,
    action,
    now,
  );
  const reason: TransferCancelReason =
    action === "decline" ? "declined" : "cancelled";
  const updated = await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledById: actor.id,
      cancelTokenHash: null,
      reason,
    },
  });
  await audit(
    {
      type: "PA_TRANSFER_CANCELLED",
      actorType: "USER",
      actorUserId: actor.id,
      targetType: "TRANSFER",
      targetId: transfer.id,
      metadata: { reason, via: "in_app" },
    },
    { db: tx },
  );
  return {
    transfer: updated,
    notice: noticeFor("cancelled", updated, { reason }),
  };
}

/** The recipient turns the transfer down. */
export function declineTransfer(
  tx: Tx,
  input: { transferId: string; actorId: string },
  now: Date,
): Promise<TransitionResult> {
  return cancelByPerson(tx, input, "decline", now);
}

/** The sending Primary Admin withdraws the transfer from inside the app. */
export function cancelTransfer(
  tx: Tx,
  input: { transferId: string; actorId: string },
  now: Date,
): Promise<TransitionResult> {
  return cancelByPerson(tx, input, "cancel", now);
}

/**
 * The emailed cancel link. Holding the token is the sender's authority, so no
 * session is involved. Unknown, used and completed tokens all return `null`, so
 * a caller cannot tell them apart. Single use comes from the state: every exit
 * from COOLING clears the hash, and the row lock makes two POSTs take turns.
 */
export async function consumeCancelToken(
  tx: Tx,
  rawToken: string,
  now: Date,
): Promise<TransitionResult | null> {
  const tokenHash = hashCancelToken(rawToken);
  const found = await tx.primaryAdminTransfer.findUnique({
    where: { cancelTokenHash: tokenHash },
    select: { id: true },
  });
  if (!found) return null;

  await lockTransfer(tx, found.id);
  // Read again under the lock: a job or another POST may have got there first.
  const transfer = await tx.primaryAdminTransfer.findUnique({
    where: { id: found.id },
  });
  if (
    !transfer ||
    transfer.cancelTokenHash !== tokenHash ||
    !checkTransition(transfer, "cancelByToken", now).ok
  ) {
    return null;
  }

  const updated = await tx.primaryAdminTransfer.update({
    where: { id: transfer.id },
    data: {
      status: "CANCELLED",
      cancelledAt: now,
      cancelledById: transfer.fromUserId,
      cancelTokenHash: null,
      reason: "cancelled",
    },
  });
  await audit(
    {
      type: "PA_TRANSFER_CANCELLED",
      actorType: "USER",
      actorUserId: transfer.fromUserId,
      targetType: "TRANSFER",
      targetId: transfer.id,
      metadata: { reason: "cancelled", via: "email_link" },
    },
    { db: tx },
  );
  return {
    transfer: updated,
    notice: noticeFor("cancelled", updated, { reason: "cancelled" }),
  };
}

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(TOKEN_ACTION_RESULTS).optional(),
});

export type PaCancelView =
  | {
      state: "ready";
      token: string;
      recipientName: string;
      executesAt: Date;
    }
  | { state: TokenActionResult };

/**
 * What the public cancel page shows on GET. Read-only by construction: it looks
 * the token up and never claims it, so a scanner pre-fetch consumes nothing.
 * Its `select` holds no token hash and no email address.
 */
export async function loadPaCancelView(
  searchParams: Record<string, string | string[] | undefined>,
  db: Pick<PrismaClient, "primaryAdminTransfer">,
): Promise<PaCancelView> {
  const parsed = searchParamsSchema.safeParse(searchParams);
  if (!parsed.success) return { state: "invalid" };
  const { token, result } = parsed.data;
  if (result) return { state: result };
  if (!token) return { state: "invalid" };

  const row = await db.primaryAdminTransfer.findUnique({
    where: { cancelTokenHash: hashCancelToken(token) },
    select: {
      status: true,
      executesAt: true,
      toUser: { select: { name: true, preferredName: true } },
    },
  });
  if (!row || row.status !== "COOLING" || !row.executesAt) {
    return { state: "invalid" };
  }
  return {
    state: "ready",
    token,
    recipientName: displayName(row.toUser),
    executesAt: row.executesAt,
  };
}
