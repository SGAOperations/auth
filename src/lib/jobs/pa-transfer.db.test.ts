import { beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import { runPaTransferJob, type TransferNotice } from "@/lib/jobs/pa-transfer";
import { createAdmin, createSession, createUser } from "@/test/factories";

const HOUR_MS = 60 * 60 * 1000;

// The harness never commits a Primary Admin (a committed one could not be
// cleared again), so the execute path is exercised inside a transaction that
// the test rolls back. These sentinels carry that rollback out of the job.
class Rollback extends Error {}

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, opened };
}

async function coolingTransfer(overrides: { executesAt?: Date } = {}) {
  const from = await createAdmin();
  const to = await createAdmin();
  const transfer = await prisma.primaryAdminTransfer.create({
    data: {
      fromUserId: from.id,
      toUserId: to.id,
      status: "COOLING",
      acceptedAt: new Date(Date.now() - 25 * HOUR_MS),
      executesAt: overrides.executesAt ?? new Date(Date.now() - HOUR_MS),
    },
  });
  return { from, to, transfer };
}

async function auditCount(transferId: string, type: string) {
  return prisma.auditEvent.count({
    where: { targetType: "TRANSFER", targetId: transferId, type },
  });
}

describe("runPaTransferJob", () => {
  beforeAll(async () => {
    // A committed Primary Admin would break the execute-path assertions, and
    // the reset cannot remove one.
    expect(await prisma.user.count({ where: { isPrimaryAdmin: true } })).toBe(
      0,
    );
  });

  beforeEach(async () => {
    await prisma.primaryAdminTransfer.deleteMany();
  });

  it("executes a due transfer once while a concurrent run skips it, and rolls back cleanly", async () => {
    const { from, to, transfer } = await coolingTransfer();
    await createSession(from);
    await createSession(to);
    const claimed = gate();
    const release = gate();
    const seen: Record<string, unknown> = {};

    const first = runPaTransferJob({
      hooks: {
        // The sender is promoted inside the transaction only, so no Primary
        // Admin is ever committed.
        afterClaim: async (tx) => {
          await tx.user.update({
            where: { id: from.id },
            data: { isPrimaryAdmin: true },
          });
        },
        beforeCommit: async (tx) => {
          seen.primaryAdmins = (
            await tx.user.findMany({
              where: { isPrimaryAdmin: true },
              select: { id: true },
            })
          ).map((user) => user.id);
          seen.admins = await tx.user.count({
            where: { id: { in: [from.id, to.id] }, isAdmin: true },
          });
          seen.sessions = await tx.session.count({
            where: { userId: { in: [from.id, to.id] } },
          });
          seen.status = (
            await tx.primaryAdminTransfer.findUniqueOrThrow({
              where: { id: transfer.id },
            })
          ).status;
          seen.audit = await tx.auditEvent.count({
            where: {
              targetType: "TRANSFER",
              targetId: transfer.id,
              type: "PA_TRANSFER_COMPLETED",
              actorType: "SYSTEM",
            },
          });
          claimed.open();
          await release.opened;
          throw new Rollback();
        },
      },
    });
    const firstOutcome = first.catch((error: unknown) => error);

    await claimed.opened;
    // The first run holds the row lock, so the second must skip the row.
    const second = await runPaTransferJob();
    expect(second).toMatchObject({ executed: 0, cancelled: 0, expired: 0 });
    release.open();

    expect(await firstOutcome).toBeInstanceOf(Rollback);
    expect(seen).toEqual({
      primaryAdmins: [to.id],
      admins: 2,
      sessions: 0,
      status: "COMPLETED",
      audit: 1,
    });

    // Rolled back: nothing changed and no Primary Admin was committed.
    const after = await prisma.primaryAdminTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
    });
    expect(after.status).toBe("COOLING");
    expect(await prisma.user.count({ where: { isPrimaryAdmin: true } })).toBe(
      0,
    );
    expect(await prisma.session.count({ where: { userId: from.id } })).toBe(1);
    expect(await auditCount(transfer.id, "PA_TRANSFER_COMPLETED")).toBe(0);
  });

  it("expires a stale pending transfer exactly once under two concurrent runs", async () => {
    const from = await createAdmin();
    const to = await createAdmin();
    const transfer = await prisma.primaryAdminTransfer.create({
      data: {
        fromUserId: from.id,
        toUserId: to.id,
        status: "PENDING_ACCEPTANCE",
        acceptanceExpiresAt: new Date(Date.now() - HOUR_MS),
      },
    });
    const notify = vi.fn();

    const results = await Promise.all([
      runPaTransferJob({ notify }),
      runPaTransferJob({ notify }),
    ]);

    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    const after = await prisma.primaryAdminTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
    });
    expect(after.status).toBe("EXPIRED");
    expect(await auditCount(transfer.id, "PA_TRANSFER_EXPIRED")).toBe(1);
    expect(notify).toHaveBeenCalledTimes(1);

    // A later run finds nothing.
    expect(await runPaTransferJob({ notify })).toMatchObject({ expired: 0 });
    expect(await auditCount(transfer.id, "PA_TRANSFER_EXPIRED")).toBe(1);
  });

  it("cancels a transfer whose recipient was deactivated during cooling", async () => {
    const { to, transfer } = await coolingTransfer();
    await prisma.user.update({
      where: { id: to.id },
      data: { status: "DEACTIVATED", deactivatedAt: new Date() },
    });
    const notices: TransferNotice[] = [];

    const result = await runPaTransferJob({
      notify: (notice) => {
        notices.push(notice);
      },
    });

    expect(result).toMatchObject({ executed: 0, cancelled: 1, expired: 0 });
    const after = await prisma.primaryAdminTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
    });
    expect(after).toMatchObject({
      status: "CANCELLED",
      reason: "recipient_ineligible",
      cancelledById: null,
    });
    expect(after.cancelledAt).not.toBeNull();
    expect(await auditCount(transfer.id, "PA_TRANSFER_CANCELLED")).toBe(1);
    expect(notices).toEqual([
      expect.objectContaining({
        kind: "cancelled",
        transferId: transfer.id,
        reason: "recipient_ineligible",
      }),
    ]);
  });

  it("cancels a transfer whose sender is no longer the Primary Admin", async () => {
    // No committed Primary Admin exists, so the sender is already not one.
    const { transfer } = await coolingTransfer();

    const result = await runPaTransferJob({ notify: vi.fn() });

    expect(result).toMatchObject({ executed: 0, cancelled: 1 });
    const after = await prisma.primaryAdminTransfer.findUniqueOrThrow({
      where: { id: transfer.id },
    });
    expect(after).toMatchObject({
      status: "CANCELLED",
      reason: "sender_not_primary_admin",
    });
    expect(await auditCount(transfer.id, "PA_TRANSFER_CANCELLED")).toBe(1);
  });

  it("leaves a not-yet-due COOLING transfer and an unexpired PENDING one alone", async () => {
    const { transfer: cooling } = await coolingTransfer({
      executesAt: new Date(Date.now() + HOUR_MS),
    });
    expect(await runPaTransferJob({ notify: vi.fn() })).toEqual({
      executed: 0,
      cancelled: 0,
      expired: 0,
      notifyFailures: 0,
    });
    expect(
      (
        await prisma.primaryAdminTransfer.findUniqueOrThrow({
          where: { id: cooling.id },
        })
      ).status,
    ).toBe("COOLING");

    await prisma.primaryAdminTransfer.delete({ where: { id: cooling.id } });
    const from = await createAdmin();
    const to = await createUser({ isAdmin: true });
    const pending = await prisma.primaryAdminTransfer.create({
      data: { fromUserId: from.id, toUserId: to.id },
    });
    expect(await runPaTransferJob({ notify: vi.fn() })).toMatchObject({
      expired: 0,
    });
    expect(
      (
        await prisma.primaryAdminTransfer.findUniqueOrThrow({
          where: { id: pending.id },
        })
      ).status,
    ).toBe("PENDING_ACCEPTANCE");
  });

  it("counts a throwing notifier and still commits the transition", async () => {
    const from = await createAdmin();
    const to = await createAdmin();
    const transfer = await prisma.primaryAdminTransfer.create({
      data: {
        fromUserId: from.id,
        toUserId: to.id,
        status: "PENDING_ACCEPTANCE",
        acceptanceExpiresAt: new Date(Date.now() - HOUR_MS),
      },
    });

    const result = await runPaTransferJob({
      notify: () => {
        throw new Error("mail down");
      },
    });

    expect(result).toMatchObject({ expired: 1, notifyFailures: 1 });
    expect(
      (
        await prisma.primaryAdminTransfer.findUniqueOrThrow({
          where: { id: transfer.id },
        })
      ).status,
    ).toBe("EXPIRED");
  });
});
