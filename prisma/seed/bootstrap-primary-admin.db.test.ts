import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";
import { createPrimaryAdmin, createUser } from "@/test/factories";
import {
  BootstrapRefusedError,
  bootstrapInTransaction,
} from "./bootstrap-primary-admin";

// The harness reset never removes a Primary Admin, so none of these tests may
// commit one. Each runs inside an interactive transaction that always rolls
// back, and asserts before it does.

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

describe("bootstrapInTransaction against the database", () => {
  it(
    "promotes a verified user with a password, revokes their sessions and audits once",
    async () => {
      await inRollback(async (tx) => {
        const user = await createUser({ password: "correct horse 1" }, tx);
        await addSessions(tx, user.id, 2);

        const plan = await bootstrapInTransaction(tx, user.email);

        expect(plan).toEqual({ userId: user.id, sessionsToRevoke: 2 });
        const after = await tx.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { isAdmin: true, isPrimaryAdmin: true },
        });
        expect(after).toEqual({ isAdmin: true, isPrimaryAdmin: true });
        expect(await tx.session.count({ where: { userId: user.id } })).toBe(0);

        const events = await tx.auditEvent.findMany({
          where: { type: "PA_BOOTSTRAPPED", targetId: user.id },
        });
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({
          actorType: "SYSTEM",
          actorUserId: null,
          targetType: "USER",
          metadata: { sessionsRevoked: 2 },
        });
      });
    },
    TIMEOUT,
  );

  it(
    "refuses and writes nothing when a Primary Admin exists",
    async () => {
      await inRollback(async (tx) => {
        await createPrimaryAdmin({}, tx);
        const user = await createUser({ password: "correct horse 1" }, tx);
        await addSessions(tx, user.id, 1);

        await expect(bootstrapInTransaction(tx, user.email)).rejects.toThrow(
          /a Primary Admin already exists/,
        );

        const after = await tx.user.findUniqueOrThrow({
          where: { id: user.id },
          select: { isAdmin: true, isPrimaryAdmin: true },
        });
        expect(after).toEqual({ isAdmin: false, isPrimaryAdmin: false });
        expect(await tx.session.count({ where: { userId: user.id } })).toBe(1);
        expect(
          await tx.auditEvent.count({
            where: { type: "PA_BOOTSTRAPPED", targetId: user.id },
          }),
        ).toBe(0);
      });
    },
    TIMEOUT,
  );

  it.each([
    [
      "an unverified user",
      { emailVerified: false, password: "correct horse 1" },
      /has not verified/,
    ],
    [
      "a deactivated user",
      { status: "DEACTIVATED" as const, password: "correct horse 1" },
      /is DEACTIVATED/,
    ],
    ["a user with no credential", {}, /has no password set/],
  ])(
    "refuses %s",
    async (_label, overrides, message) => {
      await inRollback(async (tx) => {
        const user = await createUser(overrides, tx);

        await expect(bootstrapInTransaction(tx, user.email)).rejects.toThrow(
          BootstrapRefusedError,
        );
        await expect(bootstrapInTransaction(tx, user.email)).rejects.toThrow(
          message,
        );

        expect(
          await tx.user.count({
            where: { id: user.id, isPrimaryAdmin: true },
          }),
        ).toBe(0);
      });
    },
    TIMEOUT,
  );
});
