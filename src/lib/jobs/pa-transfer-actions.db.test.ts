import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import {
  acceptTransfer,
  cancelTransfer,
  consumeCancelToken,
  declineTransfer,
  hashCancelToken,
  initiateTransfer,
  loadPaCancelView,
} from "@/lib/jobs/pa-transfer-actions";
import {
  ACCEPTANCE_WINDOW_MS,
  COOLING_MS,
} from "@/lib/jobs/pa-transfer-machine";
import { displayName } from "@/lib/user-display";
import { createAdmin, createPrimaryAdmin, createUser } from "@/test/factories";

// A Primary Admin can never be committed (src/test/db-setup.ts), so each case
// that needs one promotes the sender inside a transaction and throws this
// sentinel at the end to roll everything back.
class Rollback extends Error {}

async function inTransaction(
  body: (tx: Prisma.TransactionClient) => Promise<void>,
) {
  await prisma
    .$transaction(async (tx) => {
      await body(tx);
      throw new Rollback();
    })
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

const NOW = new Date("2026-11-03T12:00:00Z");
const HOUR_MS = 60 * 60 * 1000;

/** A Primary Admin and an MFA-enrolled admin recipient, both in `tx`. */
async function parties(tx: Prisma.TransactionClient) {
  const from = await createPrimaryAdmin({ twoFactorEnabled: true }, tx);
  const to = await createAdmin({ twoFactorEnabled: true }, tx);
  return { from, to };
}

async function started(tx: Prisma.TransactionClient) {
  const { from, to } = await parties(tx);
  const { transfer } = await initiateTransfer(
    tx,
    { actor: from, recipientUserId: to.id, confirmEmail: to.email },
    NOW,
  );
  return { from, to, transfer };
}

async function accepted(tx: Prisma.TransactionClient) {
  const { from, to, transfer } = await started(tx);
  const result = await acceptTransfer(
    tx,
    { transferId: transfer.id, actorId: to.id },
    new Date(NOW.getTime() + HOUR_MS),
  );
  const cancelToken = result.notice.cancelToken;
  if (!cancelToken) throw new Error("accept returned no cancel token");
  return { from, to, transfer: result.transfer, cancelToken };
}

function auditRows(
  tx: Prisma.TransactionClient,
  transferId: string,
  type: string,
) {
  return tx.auditEvent.findMany({
    where: { targetType: "TRANSFER", targetId: transferId, type },
  });
}

describe("Primary Admin transfer actions", () => {
  beforeAll(async () => {
    expect(await prisma.user.count({ where: { isPrimaryAdmin: true } })).toBe(
      0,
    );
  });

  beforeEach(async () => {
    await prisma.primaryAdminTransfer.deleteMany();
  });

  describe("illegal transitions", () => {
    it("refuses an acceptance by a third admin", async () => {
      await inTransaction(async (tx) => {
        const { transfer } = await started(tx);
        const third = await createAdmin({ twoFactorEnabled: true }, tx);
        await expect(
          acceptTransfer(
            tx,
            { transferId: transfer.id, actorId: third.id },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "NOT_TRANSFER_RECIPIENT" });
        expect(
          (
            await tx.primaryAdminTransfer.findUniqueOrThrow({
              where: { id: transfer.id },
            })
          ).status,
        ).toBe("PENDING_ACCEPTANCE");
      });
    });

    it("refuses a cancel by someone who is not the sender, and a decline by the sender", async () => {
      await inTransaction(async (tx) => {
        const { from, to, transfer } = await started(tx);
        await expect(
          cancelTransfer(tx, { transferId: transfer.id, actorId: to.id }, NOW),
        ).rejects.toMatchObject({ code: "NOT_TRANSFER_INITIATOR" });
        await expect(
          declineTransfer(
            tx,
            { transferId: transfer.id, actorId: from.id },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "NOT_TRANSFER_RECIPIENT" });
      });
    });

    it("refuses a cancel after completion", async () => {
      await inTransaction(async (tx) => {
        const { from, transfer } = await accepted(tx);
        await tx.primaryAdminTransfer.update({
          where: { id: transfer.id },
          data: { status: "COMPLETED", completedAt: NOW },
        });
        await expect(
          cancelTransfer(
            tx,
            { transferId: transfer.id, actorId: from.id },
            new Date(NOW.getTime() + 2 * HOUR_MS),
          ),
        ).rejects.toMatchObject({ code: "TRANSFER_INVALID_STATE" });
      });
    });

    it("refuses an unknown transfer", async () => {
      await inTransaction(async (tx) => {
        const { from } = await parties(tx);
        await expect(
          cancelTransfer(
            tx,
            { transferId: "no-such-transfer", actorId: from.id },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "TRANSFER_NOT_FOUND" });
      });
    });

    it("refuses to initiate while one is in flight", async () => {
      await inTransaction(async (tx) => {
        const { from, to } = await started(tx);
        const another = await createAdmin({ twoFactorEnabled: true }, tx);
        await expect(
          initiateTransfer(
            tx,
            {
              actor: from,
              recipientUserId: another.id,
              confirmEmail: another.email,
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "TRANSFER_IN_FLIGHT" });
        expect(await tx.primaryAdminTransfer.count()).toBe(1);
        expect(to.id).not.toBe(another.id);
      });
    });

    it("refuses an acceptance after the seven days", async () => {
      await inTransaction(async (tx) => {
        const { to, transfer } = await started(tx);
        await expect(
          acceptTransfer(
            tx,
            { transferId: transfer.id, actorId: to.id },
            new Date(NOW.getTime() + ACCEPTANCE_WINDOW_MS + 1),
          ),
        ).rejects.toMatchObject({ code: "TRANSFER_INVALID_STATE" });
      });
    });

    it("refuses a confirmation that differs in case", async () => {
      await inTransaction(async (tx) => {
        const { from, to } = await parties(tx);
        await expect(
          initiateTransfer(
            tx,
            {
              actor: from,
              recipientUserId: to.id,
              confirmEmail: to.email.toUpperCase(),
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "CONFIRM_EMAIL_MISMATCH" });
        expect(await tx.primaryAdminTransfer.count()).toBe(0);
      });
    });

    it("refuses a recipient without MFA, on initiate and on accept", async () => {
      await inTransaction(async (tx) => {
        const from = await createPrimaryAdmin({ twoFactorEnabled: true }, tx);
        const noMfa = await createAdmin({ twoFactorEnabled: false }, tx);
        await expect(
          initiateTransfer(
            tx,
            {
              actor: from,
              recipientUserId: noMfa.id,
              confirmEmail: noMfa.email,
            },
            NOW,
          ),
        ).rejects.toMatchObject({
          code: "RECIPIENT_INELIGIBLE",
          reason: "NO_MFA",
        });

        // Enrolled at the start, gone by the time they accept.
        const to = await createAdmin({ twoFactorEnabled: true }, tx);
        const { transfer } = await initiateTransfer(
          tx,
          { actor: from, recipientUserId: to.id, confirmEmail: to.email },
          NOW,
        );
        await tx.user.update({
          where: { id: to.id },
          data: { twoFactorEnabled: false },
        });
        await expect(
          acceptTransfer(tx, { transferId: transfer.id, actorId: to.id }, NOW),
        ).rejects.toMatchObject({
          code: "RECIPIENT_INELIGIBLE",
          reason: "NO_MFA",
        });
      });
    });

    it("refuses a recipient who is not an active admin, and the sender themselves", async () => {
      await inTransaction(async (tx) => {
        const from = await createPrimaryAdmin({ twoFactorEnabled: true }, tx);
        const plain = await createUser({ twoFactorEnabled: true }, tx);
        const deactivated = await createAdmin(
          {
            twoFactorEnabled: true,
            status: "DEACTIVATED",
            deactivatedAt: new Date(),
          },
          tx,
        );
        for (const [target, code] of [
          [plain, "TARGET_NOT_ELIGIBLE"],
          [deactivated, "TARGET_NOT_ELIGIBLE"],
          [from, "SELF_MODIFICATION"],
        ] as const) {
          await expect(
            initiateTransfer(
              tx,
              {
                actor: from,
                recipientUserId: target.id,
                confirmEmail: target.email,
              },
              NOW,
            ),
          ).rejects.toMatchObject({ code });
        }
        await expect(
          initiateTransfer(
            tx,
            {
              actor: from,
              recipientUserId: "no-such-user",
              confirmEmail: "x@northeastern.edu",
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "RECIPIENT_INELIGIBLE" });
      });
    });

    it("refuses an initiation by an admin who is not the Primary Admin", async () => {
      await inTransaction(async (tx) => {
        const { to } = await parties(tx);
        const plainAdmin = await createAdmin({ twoFactorEnabled: true }, tx);
        await expect(
          initiateTransfer(
            tx,
            {
              actor: plainAdmin,
              recipientUserId: to.id,
              confirmEmail: to.email,
            },
            NOW,
          ),
        ).rejects.toMatchObject({ code: "PRIMARY_ADMIN_REQUIRED" });
      });
    });
  });

  describe("initiate and accept", () => {
    it("moves to COOLING with the 24-hour clock and a stored cancel token hash", async () => {
      await inTransaction(async (tx) => {
        const { from, to, transfer } = await started(tx);
        expect(transfer).toMatchObject({
          status: "PENDING_ACCEPTANCE",
          fromUserId: from.id,
          toUserId: to.id,
        });
        expect(transfer.acceptanceExpiresAt).toEqual(
          new Date(NOW.getTime() + ACCEPTANCE_WINDOW_MS),
        );

        const acceptAt = new Date(NOW.getTime() + HOUR_MS);
        const result = await acceptTransfer(
          tx,
          { transferId: transfer.id, actorId: to.id },
          acceptAt,
        );

        expect(result.transfer).toMatchObject({
          status: "COOLING",
          acceptedAt: acceptAt,
          executesAt: new Date(acceptAt.getTime() + COOLING_MS),
        });
        const token = result.notice.cancelToken;
        expect(token).toBeTruthy();
        expect(result.transfer.cancelTokenHash).toBe(
          hashCancelToken(token ?? ""),
        );
        expect(result.transfer.cancelTokenHash).not.toBe(token);
        expect(result.notice).toMatchObject({
          kind: "accepted",
          transferId: transfer.id,
          fromUserId: from.id,
          toUserId: to.id,
        });

        expect(
          await auditRows(tx, transfer.id, "PA_TRANSFER_INITIATED"),
        ).toHaveLength(1);
        const accepted = await auditRows(
          tx,
          transfer.id,
          "PA_TRANSFER_ACCEPTED",
        );
        expect(accepted).toHaveLength(1);
        expect(accepted[0]).toMatchObject({
          actorType: "USER",
          actorUserId: to.id,
        });
      });
    });
  });

  describe("decline and in-app cancel", () => {
    it("records a decline by the recipient and clears the hash", async () => {
      await inTransaction(async (tx) => {
        const { to, transfer } = await started(tx);
        const at = new Date(NOW.getTime() + HOUR_MS);
        const result = await declineTransfer(
          tx,
          { transferId: transfer.id, actorId: to.id },
          at,
        );
        expect(result.transfer).toMatchObject({
          status: "CANCELLED",
          reason: "declined",
          cancelledById: to.id,
          cancelledAt: at,
          cancelTokenHash: null,
        });
        expect(result.notice).toMatchObject({
          kind: "cancelled",
          reason: "declined",
        });
        const [row] = await auditRows(tx, transfer.id, "PA_TRANSFER_CANCELLED");
        expect(row).toMatchObject({ actorUserId: to.id });
        expect(row.metadata).toEqual({ reason: "declined", via: "in_app" });
      });
    });

    it("records an in-app cancel by the sender during cooling and clears the hash", async () => {
      await inTransaction(async (tx) => {
        const { from, transfer } = await accepted(tx);
        expect(transfer.cancelTokenHash).not.toBeNull();
        const result = await cancelTransfer(
          tx,
          { transferId: transfer.id, actorId: from.id },
          new Date(NOW.getTime() + 2 * HOUR_MS),
        );
        expect(result.transfer).toMatchObject({
          status: "CANCELLED",
          reason: "cancelled",
          cancelledById: from.id,
          cancelTokenHash: null,
        });
        const [row] = await auditRows(tx, transfer.id, "PA_TRANSFER_CANCELLED");
        expect(row.metadata).toEqual({ reason: "cancelled", via: "in_app" });
      });
    });

    it("lets the sender cancel while still pending, and a decline works during cooling", async () => {
      await inTransaction(async (tx) => {
        const { from, transfer } = await started(tx);
        const result = await cancelTransfer(
          tx,
          { transferId: transfer.id, actorId: from.id },
          NOW,
        );
        expect(result.transfer.status).toBe("CANCELLED");
      });
      await inTransaction(async (tx) => {
        const { to, transfer } = await accepted(tx);
        const result = await declineTransfer(
          tx,
          { transferId: transfer.id, actorId: to.id },
          new Date(NOW.getTime() + 2 * HOUR_MS),
        );
        expect(result.transfer).toMatchObject({
          status: "CANCELLED",
          reason: "declined",
        });
      });
    });
  });

  describe("the emailed cancel token", () => {
    it("shows the page for a live token without changing anything", async () => {
      await inTransaction(async (tx) => {
        const { to, transfer, cancelToken } = await accepted(tx);

        const view = await loadPaCancelView({ token: cancelToken }, tx);
        expect(view).toEqual({
          state: "ready",
          token: cancelToken,
          recipientName: displayName(to),
          executesAt: transfer.executesAt,
        });
        // A GET, however often it is repeated, consumes nothing.
        await loadPaCancelView({ token: cancelToken }, tx);
        const row = await tx.primaryAdminTransfer.findUniqueOrThrow({
          where: { id: transfer.id },
        });
        expect(row.status).toBe("COOLING");
        expect(row.cancelTokenHash).toBe(transfer.cancelTokenHash);
      });
    });

    it("answers invalid for a missing, unknown, tampered or used token, and for a result param", async () => {
      await inTransaction(async (tx) => {
        const { cancelToken } = await accepted(tx);
        expect(await loadPaCancelView({}, tx)).toEqual({ state: "invalid" });
        expect(await loadPaCancelView({ token: "nope" }, tx)).toEqual({
          state: "invalid",
        });
        expect(
          await loadPaCancelView({ token: `${cancelToken}x` }, tx),
        ).toEqual({ state: "invalid" });
        expect(await loadPaCancelView({ token: ["a", "b"] }, tx)).toEqual({
          state: "invalid",
        });
        expect(await loadPaCancelView({ result: "done" }, tx)).toEqual({
          state: "done",
        });

        await consumeCancelToken(tx, cancelToken, NOW);
        expect(await loadPaCancelView({ token: cancelToken }, tx)).toEqual({
          state: "invalid",
        });
      });
    });

    it("cancels on the first use, with no session, and refuses a second", async () => {
      await inTransaction(async (tx) => {
        const { from, transfer, cancelToken } = await accepted(tx);
        const at = new Date(NOW.getTime() + 3 * HOUR_MS);

        const first = await consumeCancelToken(tx, cancelToken, at);
        expect(first?.transfer).toMatchObject({
          status: "CANCELLED",
          reason: "cancelled",
          cancelledById: from.id,
          cancelledAt: at,
          cancelTokenHash: null,
        });
        expect(first?.notice).toMatchObject({
          kind: "cancelled",
          reason: "cancelled",
        });
        const rows = await auditRows(tx, transfer.id, "PA_TRANSFER_CANCELLED");
        expect(rows).toHaveLength(1);
        expect(rows[0]).toMatchObject({
          actorType: "USER",
          actorUserId: from.id,
        });
        expect(rows[0].metadata).toEqual({
          reason: "cancelled",
          via: "email_link",
        });

        expect(await consumeCancelToken(tx, cancelToken, at)).toBeNull();
        expect(
          await auditRows(tx, transfer.id, "PA_TRANSFER_CANCELLED"),
        ).toHaveLength(1);
      });
    });

    it("returns null for a tampered token and changes nothing", async () => {
      await inTransaction(async (tx) => {
        const { transfer, cancelToken } = await accepted(tx);
        expect(await consumeCancelToken(tx, `${cancelToken}x`, NOW)).toBeNull();
        expect(await consumeCancelToken(tx, "", NOW)).toBeNull();
        expect(
          (
            await tx.primaryAdminTransfer.findUniqueOrThrow({
              where: { id: transfer.id },
            })
          ).status,
        ).toBe("COOLING");
      });
    });

    it("returns null for a token whose transfer has completed, even if the hash was left behind", async () => {
      await inTransaction(async (tx) => {
        const { transfer, cancelToken } = await accepted(tx);
        await tx.primaryAdminTransfer.update({
          where: { id: transfer.id },
          data: { status: "COMPLETED", completedAt: NOW },
        });
        expect(await consumeCancelToken(tx, cancelToken, NOW)).toBeNull();
        expect(
          (
            await tx.primaryAdminTransfer.findUniqueOrThrow({
              where: { id: transfer.id },
            })
          ).status,
        ).toBe("COMPLETED");
      });
    });

    it("lets the token cancel after executesAt while the job has not yet run", async () => {
      await inTransaction(async (tx) => {
        const { transfer, cancelToken } = await accepted(tx);
        const afterExecutesAt = new Date(
          (transfer.executesAt?.getTime() ?? NOW.getTime()) + HOUR_MS,
        );
        const result = await consumeCancelToken(
          tx,
          cancelToken,
          afterExecutesAt,
        );
        expect(result?.transfer.status).toBe("CANCELLED");
      });
    });
  });
});
