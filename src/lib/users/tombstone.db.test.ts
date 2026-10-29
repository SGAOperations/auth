import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { tombstoneUser } from "@/lib/users/tombstone";
import {
  createAdmin,
  createPosition,
  createPrimaryAdmin,
  createSession,
  createUser,
} from "@/test/factories";
import type { PrismaClient } from "@/generated/prisma/client";

const actorOf = (user: { id: string }) =>
  ({ actorType: "USER", actorUserId: user.id }) as const;

async function richUser() {
  const user = await createUser({
    password: "correct-horse-battery-staple",
    preferredName: "Sam",
    twoFactorEnabled: true,
    isAdmin: true,
    legacyEmail: true,
  });
  // KnownDevice and UnlockToken CHECK their tokenHash as 64 lower-case hex.
  const hexHash = () => randomBytes(32).toString("hex");
  const [positions] = await Promise.all([
    Promise.all([createPosition(), createPosition()]),
    createSession(user),
    createSession(user),
    prisma.twoFactor.create({
      data: { userId: user.id, secret: "s", backupCodes: "b" },
    }),
    prisma.knownDevice.create({
      data: { userId: user.id, tokenHash: hexHash() },
    }),
    prisma.unlockToken.create({
      data: {
        userId: user.id,
        tokenHash: hexHash(),
        expiresAt: new Date(Date.now() + 60_000),
      },
    }),
    prisma.accountLock.create({ data: { userId: user.id } }),
    prisma.verification.createMany({
      data: [
        {
          identifier: user.email,
          value: "by-email",
          expiresAt: new Date(Date.now() + 60_000),
        },
        {
          identifier: `set-password:${user.id}`,
          value: user.id,
          expiresAt: new Date(Date.now() + 60_000),
        },
      ],
    }),
  ]);
  await prisma.userPosition.createMany({
    data: positions.map((p) => ({ userId: user.id, positionId: p.id })),
  });
  return { user, positions };
}

describe("tombstoneUser", () => {
  let actor: Awaited<ReturnType<typeof createAdmin>>;

  beforeAll(async () => {
    actor = await createAdmin({ twoFactorEnabled: true });
  });

  it("scrubs the row, removes what hangs off it and keeps the id", async () => {
    const { user, positions } = await richUser();
    const priorEvent = await prisma.auditEvent.create({
      data: {
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        actorUserId: user.id,
        targetType: "USER",
        targetId: user.id,
        metadata: { method: "password" },
        ip: "203.0.113.9",
        userAgent: "old-browser",
      },
    });

    const result = await tombstoneUser(prisma, {
      userId: user.id,
      reason: "admin",
      actor: actorOf(actor),
    });
    expect(result).toEqual({ tombstoned: true });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row).toMatchObject({
      status: "DELETED",
      email: `deleted+${user.id}@invalid`,
      name: "Deleted user",
      preferredName: null,
      image: null,
      emailVerified: false,
      twoFactorEnabled: false,
      isAdmin: false,
    });
    expect(row.deletedAt).toBeInstanceOf(Date);

    const where = { userId: user.id };
    expect(await prisma.session.count({ where })).toBe(0);
    expect(await prisma.account.count({ where })).toBe(0);
    expect(await prisma.twoFactor.count({ where })).toBe(0);
    expect(await prisma.knownDevice.count({ where })).toBe(0);
    expect(await prisma.unlockToken.count({ where })).toBe(0);
    expect(await prisma.accountLock.count({ where })).toBe(0);
    expect(await prisma.userPosition.count({ where })).toBe(0);
    expect(
      await prisma.verification.count({
        where: { OR: [{ value: user.id }, { identifier: user.email }] },
      }),
    ).toBe(0);

    const old = await prisma.auditEvent.findUniqueOrThrow({
      where: { id: priorEvent.id },
    });
    expect(old).toMatchObject({
      ip: null,
      userAgent: null,
      actorUserId: user.id,
      metadata: { method: "password" },
    });

    const deleted = await prisma.auditEvent.findMany({
      where: { targetId: user.id, type: "USER_DELETED" },
    });
    expect(deleted).toHaveLength(1);
    expect(deleted[0]).toMatchObject({
      actorUserId: actor.id,
      ip: null,
      userAgent: null,
    });
    const metadata = deleted[0].metadata as {
      reason: string;
      removedPositionIds: string[];
    };
    expect(metadata.reason).toBe("admin");
    expect([...metadata.removedPositionIds].sort()).toEqual(
      positions.map((p) => p.id).sort(),
    );
  });

  it("records a retention rule as the reason, as a system action", async () => {
    const user = await createUser({
      lastLoginAt: new Date(),
      inactivityNoticeSentAt: new Date(),
    });
    await tombstoneUser(prisma, {
      userId: user.id,
      reason: "inactive_12mo",
      actor: { actorType: "SYSTEM" },
    });

    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ status: "DELETED", inactivityNoticeSentAt: null });
    const rows = await prisma.auditEvent.findMany({
      where: { targetId: user.id, type: "USER_DELETED" },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "SYSTEM",
      actorUserId: null,
      metadata: { reason: "inactive_12mo", removedPositionIds: [] },
    });
  });

  it("lets the old address sign up again as a different user", async () => {
    const { user } = await richUser();
    await tombstoneUser(prisma, {
      userId: user.id,
      reason: "admin",
      actor: actorOf(actor),
    });
    const again = await prisma.user.create({
      data: { email: user.email, name: "Returning" },
    });
    expect(again.id).not.toBe(user.id);
  });

  it("refuses the Primary Admin and changes nothing", async () => {
    // A committed Primary Admin could never be removed, so this one lives in a
    // transaction that rolls back, and tombstoneUser joins it.
    class Rollback extends Error {}
    await prisma
      .$transaction(async (tx) => {
        const primary = await createPrimaryAdmin({}, tx);
        const joined = {
          $transaction: (fn: (db: typeof tx) => Promise<unknown>) => fn(tx),
        } as unknown as PrismaClient;
        const events = await tx.auditEvent.count({
          where: { targetId: primary.id, type: "USER_DELETED" },
        });
        const result = await tombstoneUser(joined, {
          userId: primary.id,
          reason: "admin",
          actor: actorOf(actor),
        });
        expect(result).toEqual({ tombstoned: false });
        expect(
          await tx.user.findUniqueOrThrow({ where: { id: primary.id } }),
        ).toMatchObject({ status: "ACTIVE", isPrimaryAdmin: true });
        expect(
          await tx.auditEvent.count({
            where: { targetId: primary.id, type: "USER_DELETED" },
          }),
        ).toBe(events);
        throw new Rollback();
      })
      .catch((error: unknown) => {
        if (!(error instanceof Rollback)) throw error;
      });
  });

  it("does nothing when the guard does not match", async () => {
    const { user } = await richUser();
    const result = await tombstoneUser(prisma, {
      userId: user.id,
      reason: "admin",
      actor: actorOf(actor),
      guard: { status: "DEACTIVATED" },
    });
    expect(result).toEqual({ tombstoned: false });
    expect(
      await prisma.user.findUniqueOrThrow({ where: { id: user.id } }),
    ).toMatchObject({ status: "ACTIVE", email: user.email });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(2);
    expect(
      await prisma.auditEvent.count({
        where: { targetId: user.id, type: "USER_DELETED" },
      }),
    ).toBe(0);
  });

  it("is a no-op for an unknown user and for one already deleted", async () => {
    const unknown = await tombstoneUser(prisma, {
      userId: "0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e",
      reason: "admin",
      actor: actorOf(actor),
    });
    expect(unknown).toEqual({ tombstoned: false });

    const gone = await createUser({ status: "DELETED" });
    const again = await tombstoneUser(prisma, {
      userId: gone.id,
      reason: "admin",
      actor: actorOf(actor),
    });
    expect(again).toEqual({ tombstoned: false });
  });
});
