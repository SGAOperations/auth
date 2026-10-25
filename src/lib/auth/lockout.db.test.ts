import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { rememberDevice } from "@/lib/auth/known-device";
import {
  checkSignIn,
  clearAccountLock,
  recordFailedSignIn,
  recordSuccessfulSignIn,
} from "@/lib/auth/lockout";
import {
  BASE_LOCK_MS,
  DEVICE_LOCK_MS,
  FAILURE_THRESHOLD,
} from "@/lib/auth/lockout-policy";
import { consumeUnlockToken, issueUnlockToken } from "@/lib/auth/unlock-token";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const NOW = new Date("2026-06-01T12:00:00Z");
const at = (ms: number) => new Date(NOW.getTime() + ms);

describe.skipIf(!url)("lockout service against the database", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  async function createUser() {
    const email = `t64-${counter++}-${rand}@northeastern.edu`;
    return prisma.user.create({ data: { email, name: "Lockout Test" } });
  }

  const failure = (userId: string, now: Date, deviceId: string | null = null) =>
    recordFailedSignIn(prisma, { userId, deviceId, ip: null, now });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  it("produces exactly one lock from five concurrent failures", async () => {
    const user = await createUser();
    const results = await Promise.all(
      Array.from({ length: FAILURE_THRESHOLD }, () => failure(user.id, NOW)),
    );

    expect(results.filter((result) => result.locked !== null)).toHaveLength(1);
    const row = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(row.failedCount).toBe(0);
    expect(row.lockLevel).toBe(1);
    expect(row.lockedUntil).toEqual(at(BASE_LOCK_MS));
  });

  it("escalates the second lock to 30 minutes", async () => {
    const user = await createUser();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await failure(user.id, NOW);

    const after = at(BASE_LOCK_MS + 1000);
    let last: Awaited<ReturnType<typeof failure>>["locked"] = null;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      last = (await failure(user.id, after)).locked;
    }
    expect(last).toMatchObject({ level: 2, durationMs: 2 * BASE_LOCK_MS });
  });

  it("rolls the lock back when the onLocked hook fails", async () => {
    const user = await createUser();
    for (let i = 0; i < FAILURE_THRESHOLD - 1; i++) {
      await failure(user.id, NOW);
    }
    await expect(
      recordFailedSignIn(prisma, {
        userId: user.id,
        deviceId: null,
        ip: null,
        now: NOW,
        onLocked: async () => {
          throw new Error("hook failed");
        },
      }),
    ).rejects.toThrow("hook failed");

    const row = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(row.failedCount).toBe(FAILURE_THRESHOLD - 1);
    expect(row.lockedUntil).toBeNull();
  });

  it("counts a device failure on the device and never on the account", async () => {
    const user = await createUser();
    const raw = await rememberDevice(prisma, {
      userId: user.id,
      raw: null,
      userAgent: null,
      now: NOW,
    });
    const device = await prisma.knownDevice.findFirstOrThrow({
      where: { userId: user.id },
    });

    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      await failure(user.id, NOW, device.id);
    }

    expect(
      await prisma.accountLock.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
    const row = await prisma.knownDevice.findUniqueOrThrow({
      where: { id: device.id },
    });
    expect(row.lockedUntil).toEqual(at(DEVICE_LOCK_MS));
    expect(row.failedCount).toBe(0);

    const check = await checkSignIn(prisma, {
      email: user.email,
      deviceRaw: raw,
      now: at(1000),
    });
    expect(check).toMatchObject({ outcome: "refuse", scope: "device" });
  });

  it("lets a known device in while the account is locked, and no one else", async () => {
    const user = await createUser();
    const raw = await rememberDevice(prisma, {
      userId: user.id,
      raw: null,
      userAgent: null,
      now: NOW,
    });
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await failure(user.id, NOW);

    const later = at(1000);
    expect(
      await checkSignIn(prisma, {
        email: user.email,
        deviceRaw: null,
        now: later,
      }),
    ).toMatchObject({ outcome: "refuse", scope: "account" });
    expect(
      await checkSignIn(prisma, {
        email: user.email,
        deviceRaw: raw,
        now: later,
      }),
    ).toMatchObject({ outcome: "proceed", userId: user.id });

    const stranger = await createUser();
    expect(
      await checkSignIn(prisma, {
        email: stranger.email,
        deviceRaw: raw,
        now: later,
      }),
    ).toMatchObject({ outcome: "proceed", deviceId: null });
  });

  it("treats an unknown email like an unlocked account", async () => {
    expect(
      await checkSignIn(prisma, {
        email: `nobody-${rand}@northeastern.edu`,
        deviceRaw: null,
        now: NOW,
      }),
    ).toEqual({ outcome: "proceed", userId: null, deviceId: null });
  });

  it("resets the counter on success but keeps an active lock", async () => {
    const user = await createUser();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await failure(user.id, NOW);
    await recordSuccessfulSignIn(prisma, {
      userId: user.id,
      deviceId: null,
      now: at(1000),
    });

    const row = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(row.lockedUntil).toEqual(at(BASE_LOCK_MS));
  });

  it("clearAccountLock lifts the lock, keeps the level and revokes unlock links", async () => {
    const user = await createUser();
    for (let i = 0; i < FAILURE_THRESHOLD; i++) await failure(user.id, NOW);
    const raw = await issueUnlockToken(prisma, user.id, NOW);

    const result = await prisma.$transaction((tx) =>
      clearAccountLock(tx, { userId: user.id, now: at(1000) }),
    );
    expect(result).toEqual({ wasLocked: true });

    const row = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(row.lockedUntil).toBeNull();
    expect(row.lockLevel).toBe(1);
    expect(await consumeUnlockToken(prisma, raw, at(2000))).toBeNull();

    const again = await prisma.$transaction((tx) =>
      clearAccountLock(tx, { userId: user.id, now: at(3000) }),
    );
    expect(again).toEqual({ wasLocked: false });
  });

  it("rejects a malformed device token hash and a negative counter", async () => {
    const user = await createUser();
    await expect(
      prisma.knownDevice.create({
        data: { userId: user.id, tokenHash: "not-a-sha256" },
      }),
    ).rejects.toThrow();

    const raw = await rememberDevice(prisma, {
      userId: user.id,
      raw: null,
      userAgent: null,
      now: NOW,
    });
    expect(raw).toBeTruthy();
    await expect(
      prisma.knownDevice.updateMany({
        where: { userId: user.id },
        data: { failedCount: -1 },
      }),
    ).rejects.toThrow();
  });

  it("keeps a held device token and prunes beyond the per-user cap", async () => {
    const user = await createUser();
    const first = await rememberDevice(prisma, {
      userId: user.id,
      raw: null,
      userAgent: "ua",
      now: NOW,
    });
    expect(
      await rememberDevice(prisma, {
        userId: user.id,
        raw: first,
        userAgent: "ua",
        now: at(1000),
      }),
    ).toBe(first);
    expect(await prisma.knownDevice.count({ where: { userId: user.id } })).toBe(
      1,
    );

    for (let i = 0; i < 25; i++) {
      await rememberDevice(prisma, {
        userId: user.id,
        raw: null,
        userAgent: null,
        now: at(10_000 + i * 1000),
      });
    }
    expect(await prisma.knownDevice.count({ where: { userId: user.id } })).toBe(
      20,
    );
  });
});
