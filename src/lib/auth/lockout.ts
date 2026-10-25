import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { auditIp } from "@/lib/audit";
import {
  applyAccountFailure,
  applyAccountSuccess,
  applyAccountUnlock,
  applyDeviceFailure,
  applyDeviceSuccess,
  isLocked,
  type LockEvent,
} from "@/lib/auth/lockout-policy";
import { findDevice } from "@/lib/auth/known-device";
import { revokeUnlockTokens } from "@/lib/auth/unlock-token";

// The service that applies lockout-policy.ts to AccountLock and KnownDevice
// rows (docs/LOCKOUT.md). Every function takes an explicit `now`.

type ReadDb = Pick<PrismaClient, "user" | "knownDevice">;
type WriteDb = Pick<
  Prisma.TransactionClient,
  "accountLock" | "knownDevice" | "unlockToken" | "$executeRaw" | "$queryRaw"
>;

export type SignInCheck =
  | { outcome: "proceed"; userId: string | null; deviceId: string | null }
  | { outcome: "refuse"; userId: string; scope: "account" | "device" };

/**
 * Decides whether a password sign-in may be attempted. It reads the same
 * single user row for every email, so an unknown address and a locked one take
 * the same path up to the refusal.
 *
 * A device counts only when its cookie names a row that belongs to the account
 * being signed in to. A valid device is exempt from the account lock and is
 * refused only for its own lock.
 */
export async function checkSignIn(
  db: ReadDb,
  {
    email,
    deviceRaw,
    now,
  }: { email: string; deviceRaw: string | null; now: Date },
): Promise<SignInCheck> {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true, accountLock: { select: { lockedUntil: true } } },
  });
  const found = deviceRaw ? await findDevice(db, deviceRaw) : null;
  const device = user && found?.userId === user.id ? found : null;

  if (device) {
    return isLocked(device, now)
      ? { outcome: "refuse", userId: device.userId, scope: "device" }
      : { outcome: "proceed", userId: device.userId, deviceId: device.id };
  }
  if (user && isLocked(user.accountLock ?? { lockedUntil: null }, now)) {
    return { outcome: "refuse", userId: user.id, scope: "account" };
  }
  return { outcome: "proceed", userId: user?.id ?? null, deviceId: null };
}

/**
 * Counts one failed password. With a `deviceId` the failure goes to that
 * device's own counter and never touches the account's. The row is locked for
 * the read-modify-write, so five concurrent failures produce one lock.
 *
 * `onLocked` runs inside the transaction when this failure takes the account
 * lock, so the unlock token and the audit row commit with the lock or not at
 * all. Exported for the re-auth and change-password paths, which count their
 * own wrong passwords.
 */
export async function recordFailedSignIn(
  prisma: PrismaClient,
  {
    userId,
    deviceId,
    ip,
    now,
    onLocked,
  }: {
    userId: string;
    deviceId: string | null;
    ip: string | null;
    now: Date;
    onLocked?: (tx: Prisma.TransactionClient, lock: LockEvent) => Promise<void>;
  },
): Promise<{ locked: LockEvent | null }> {
  return prisma.$transaction(async (tx) => {
    if (deviceId) {
      await tx.$queryRaw`SELECT "id" FROM "KnownDevice" WHERE "id" = ${deviceId} FOR UPDATE`;
      const device = await tx.knownDevice.findUnique({
        where: { id: deviceId },
        select: { failedCount: true, windowStartedAt: true, lockedUntil: true },
      });
      if (!device) return { locked: null };
      const { state } = applyDeviceFailure(device, now);
      await tx.knownDevice.update({ where: { id: deviceId }, data: state });
      return { locked: null };
    }

    await tx.$executeRaw`INSERT INTO "AccountLock" ("userId", "windowStartedAt") VALUES (${userId}, ${now}) ON CONFLICT ("userId") DO NOTHING`;
    await tx.$queryRaw`SELECT "userId" FROM "AccountLock" WHERE "userId" = ${userId} FOR UPDATE`;
    const row = await tx.accountLock.findUniqueOrThrow({ where: { userId } });
    const { state, locked } = applyAccountFailure(row, now);
    // Already locked: the policy changed nothing.
    if (state === row) return { locked: null };

    await tx.accountLock.update({
      where: { userId },
      data: {
        failedCount: state.failedCount,
        windowStartedAt: state.windowStartedAt,
        lockedUntil: state.lockedUntil,
        lockLevel: state.lockLevel,
        lastFailedAt: state.lastFailedAt,
        lastFailedIp: auditIp(ip),
      },
    });
    if (locked) await onLocked?.(tx, locked);
    return { locked };
  });
}

/**
 * Resets the failure counters after a completed login. Writes only the
 * counter columns, never `lockedUntil`, so a racing failure's lock survives.
 */
export async function recordSuccessfulSignIn(
  db: Pick<PrismaClient, "accountLock" | "knownDevice">,
  {
    userId,
    deviceId,
    now,
  }: { userId: string; deviceId: string | null; now: Date },
): Promise<void> {
  const lock = await db.accountLock.findUnique({ where: { userId } });
  if (lock) {
    const { failedCount, windowStartedAt } = applyAccountSuccess(lock, now);
    await db.accountLock.update({
      where: { userId },
      data: { failedCount, windowStartedAt },
    });
  }
  if (deviceId) {
    const device = await db.knownDevice.findUnique({
      where: { id: deviceId },
      select: { failedCount: true, windowStartedAt: true, lockedUntil: true },
    });
    if (device) {
      const { failedCount, windowStartedAt } = applyDeviceSuccess(device, now);
      await db.knownDevice.update({
        where: { id: deviceId },
        data: { failedCount, windowStartedAt },
      });
    }
  }
}

/**
 * Lifts the account lock and kills any outstanding unlock link. It does not
 * audit: the caller does, since the method differs (unlock link, password
 * reset, admin). Exported for the admin unlock endpoint.
 */
export async function clearAccountLock(
  db: WriteDb,
  { userId, now }: { userId: string; now: Date },
): Promise<{ wasLocked: boolean }> {
  await db.$queryRaw`SELECT "userId" FROM "AccountLock" WHERE "userId" = ${userId} FOR UPDATE`;
  const row = await db.accountLock.findUnique({ where: { userId } });
  const wasLocked = row !== null && isLocked(row, now);
  if (row) {
    const { lockedUntil, failedCount, windowStartedAt } = applyAccountUnlock(
      row,
      now,
    );
    await db.accountLock.update({
      where: { userId },
      data: { lockedUntil, failedCount, windowStartedAt },
    });
  }
  await revokeUnlockTokens(db, userId, now);
  return { wasLocked };
}
