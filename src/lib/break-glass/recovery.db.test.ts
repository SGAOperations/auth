import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import {
  RecoveryStateChanged,
  applyRecovery,
  planRecovery,
  readRecoveryState,
  verifyRecovery,
  type RecoveryInput,
} from "@/lib/break-glass/recovery";
import { prisma } from "@/lib/prisma";
import { createAdmin, createPrimaryAdmin } from "@/test/factories";

// The harness reset never removes a Primary Admin, and a transfer cannot commit
// without one, so none of these tests may commit. Each runs inside an
// interactive transaction that always rolls back, and asserts before it does.

class Rollback extends Error {}

const TIMEOUT = 60_000;

async function inRollback(fn: (tx: Prisma.TransactionClient) => Promise<void>) {
  let failure: unknown;
  await prisma
    .$transaction(
      async (tx) => {
        try {
          await tx.$queryRaw`SELECT set_config('sgauth.pa_transfer', 'on', true)`;
          await tx.user.updateMany({
            where: { isPrimaryAdmin: true },
            data: { isPrimaryAdmin: false },
          });
          await tx.$queryRaw`SELECT set_config('sgauth.pa_transfer', 'off', true)`;
          await tx.primaryAdminTransfer.updateMany({
            where: { status: { in: ["PENDING_ACCEPTANCE", "COOLING"] } },
            data: { status: "CANCELLED" },
          });
          await fn(tx);
        } catch (error) {
          failure = error;
        }
        throw new Rollback();
      },
      { timeout: TIMEOUT, maxWait: 15_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
  if (failure) throw failure;
}

async function addSessions(
  tx: Prisma.TransactionClient,
  userId: string,
  count: number,
) {
  for (let i = 0; i < count; i += 1) {
    await tx.session.create({
      data: {
        userId,
        token: randomBytes(24).toString("base64url"),
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }
}

function input(
  email: string,
  overrides: Partial<RecoveryInput> = {},
): RecoveryInput {
  return {
    mode: "transfer",
    email,
    operator: "Ada Lovelace",
    reason: "Primary Admin unreachable",
    demotePrevious: false,
    ...overrides,
  };
}

async function plan(tx: Prisma.TransactionClient, request: RecoveryInput) {
  return planRecovery(await readRecoveryState(tx, request.email), request);
}

describe("break-glass recovery against the database", () => {
  it(
    "moves the flag, signs out the old Primary Admin and writes one audit row",
    async () => {
      await inRollback(async (tx) => {
        const oldPa = await createPrimaryAdmin({}, tx);
        const target = await createAdmin({}, tx);
        await addSessions(tx, oldPa.id, 2);
        await addSessions(tx, target.id, 1);
        const request = input(target.email);

        const result = await applyRecovery(
          tx,
          request,
          await plan(tx, request),
        );

        const primaryAdmins = await tx.user.findMany({
          where: { isPrimaryAdmin: true },
          select: { id: true },
        });
        expect(primaryAdmins).toEqual([{ id: target.id }]);
        const old = await tx.user.findUniqueOrThrow({
          where: { id: oldPa.id },
        });
        expect(old.isAdmin).toBe(true);
        expect(await tx.session.count({ where: { userId: oldPa.id } })).toBe(0);
        expect(await tx.session.count({ where: { userId: target.id } })).toBe(
          1,
        );

        expect(result.sessionsRevoked).toBe(2);
        expect(result.recipients).toEqual(
          expect.arrayContaining([oldPa.email, target.email]),
        );
        const audit = await tx.auditEvent.findUniqueOrThrow({
          where: { id: result.auditEventId },
        });
        expect(audit).toMatchObject({
          type: "BREAK_GLASS_PA_RECOVERY",
          actorType: "BREAK_GLASS",
          actorUserId: null,
          targetType: "USER",
          targetId: target.id,
          ip: null,
          userAgent: null,
          metadata: {
            mode: "transfer",
            operator: "Ada Lovelace",
            reason: "Primary Admin unreachable",
            previousPrimaryAdminId: oldPa.id,
            previousAdminRevoked: false,
            sessionsRevoked: 2,
          },
        });
        await expect(verifyRecovery(tx, result)).resolves.toEqual({
          primaryAdminEmail: target.email,
        });
      });
    },
    TIMEOUT,
  );

  it(
    "cancels an in-flight transfer and revokes the old admin flag on request",
    async () => {
      await inRollback(async (tx) => {
        const oldPa = await createPrimaryAdmin({}, tx);
        const target = await createAdmin({}, tx);
        const transfer = await tx.primaryAdminTransfer.create({
          data: {
            fromUserId: oldPa.id,
            toUserId: target.id,
            status: "COOLING",
          },
        });
        const request = input(target.email, { demotePrevious: true });

        const result = await applyRecovery(
          tx,
          request,
          await plan(tx, request),
        );

        const cancelled = await tx.primaryAdminTransfer.findUniqueOrThrow({
          where: { id: transfer.id },
        });
        expect(cancelled.status).toBe("CANCELLED");
        expect(cancelled.cancelledAt).not.toBeNull();
        expect(cancelled.cancelledById).toBeNull();
        const old = await tx.user.findUniqueOrThrow({
          where: { id: oldPa.id },
        });
        expect(old).toMatchObject({ isAdmin: false, isPrimaryAdmin: false });
        const audit = await tx.auditEvent.findUniqueOrThrow({
          where: { id: result.auditEventId },
        });
        expect(audit.metadata).toMatchObject({
          cancelledTransferId: transfer.id,
          previousAdminRevoked: true,
        });
      });
    },
    TIMEOUT,
  );

  it(
    "promotes a plain active user to admin and Primary Admin",
    async () => {
      await inRollback(async (tx) => {
        await createPrimaryAdmin({}, tx);
        const target = await createAdmin({ isAdmin: false }, tx);
        const request = input(target.email);

        await applyRecovery(tx, request, await plan(tx, request));

        const promoted = await tx.user.findUniqueOrThrow({
          where: { id: target.id },
        });
        expect(promoted).toMatchObject({
          isAdmin: true,
          isPrimaryAdmin: true,
        });
      });
    },
    TIMEOUT,
  );

  it(
    "resets the Primary Admin's MFA and signs them out",
    async () => {
      await inRollback(async (tx) => {
        const pa = await createPrimaryAdmin({ twoFactorEnabled: true }, tx);
        await tx.twoFactor.create({
          data: { userId: pa.id, secret: "secret", backupCodes: "codes" },
        });
        await addSessions(tx, pa.id, 1);
        const request = input(pa.email, { mode: "reset_mfa" });

        const result = await applyRecovery(
          tx,
          request,
          await plan(tx, request),
        );

        expect(await tx.twoFactor.count({ where: { userId: pa.id } })).toBe(0);
        const after = await tx.user.findUniqueOrThrow({ where: { id: pa.id } });
        expect(after).toMatchObject({
          twoFactorEnabled: false,
          isPrimaryAdmin: true,
        });
        expect(await tx.session.count({ where: { userId: pa.id } })).toBe(0);
        const audit = await tx.auditEvent.findUniqueOrThrow({
          where: { id: result.auditEventId },
        });
        expect(audit.metadata).toEqual({
          mode: "reset_mfa",
          operator: "Ada Lovelace",
          reason: "Primary Admin unreachable",
          sessionsRevoked: 1,
        });
        await expect(verifyRecovery(tx, result)).resolves.toEqual({
          primaryAdminEmail: pa.email,
        });
      });
    },
    TIMEOUT,
  );

  it(
    "writes nothing when the state changed after the plan was shown",
    async () => {
      await inRollback(async (tx) => {
        const oldPa = await createPrimaryAdmin({}, tx);
        const target = await createAdmin({}, tx);
        const request = input(target.email);
        const shown = await plan(tx, request);

        await tx.primaryAdminTransfer.create({
          data: {
            fromUserId: oldPa.id,
            toUserId: target.id,
            status: "PENDING_ACCEPTANCE",
          },
        });

        await expect(applyRecovery(tx, request, shown)).rejects.toBeInstanceOf(
          RecoveryStateChanged,
        );
        const stillPa = await tx.user.findUniqueOrThrow({
          where: { id: oldPa.id },
        });
        expect(stillPa.isPrimaryAdmin).toBe(true);
        expect(
          await tx.auditEvent.count({ where: { targetId: target.id } }),
        ).toBe(0);
      });
    },
    TIMEOUT,
  );

  it(
    "verifyRecovery fails when the expected Primary Admin does not hold the flag",
    async () => {
      await inRollback(async (tx) => {
        const pa = await createPrimaryAdmin({}, tx);
        const other = await createAdmin({}, tx);
        const audit = await tx.auditEvent.create({
          data: {
            type: "BREAK_GLASS_PA_RECOVERY",
            actorType: "BREAK_GLASS",
            targetType: "USER",
            targetId: pa.id,
            metadata: {},
          },
        });
        await expect(
          verifyRecovery(tx, {
            mode: "transfer",
            auditEventId: audit.id,
            recipients: [],
            sessionsRevoked: 0,
            primaryAdminId: other.id,
            primaryAdminEmail: other.email,
            previousPrimaryAdminEmail: null,
          }),
        ).rejects.toThrow("Expected exactly one Primary Admin");
      });
    },
    TIMEOUT,
  );
});
