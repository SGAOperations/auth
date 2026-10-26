import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  ADMIN_INVITE_TTL_MINUTES,
  FIRST_SIGN_IN_TTL_MINUTES,
  SET_PASSWORD_PREFIX,
  consumeSetPasswordToken,
  hashSetPasswordToken,
  issueSetPasswordToken,
  peekSetPasswordToken,
  revokeSetPasswordTokens,
} from "@/lib/set-password/token";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("set-password tokens in the database", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const userIds: string[] = [];

  async function freshUser() {
    const user = await prisma.user.create({
      data: {
        email: `t22-token-${counter++}-${rand}@northeastern.edu`,
        name: "Token Test",
      },
    });
    userIds.push(user.id);
    return user.id;
  }

  const rows = (userId: string) =>
    prisma.verification.findMany({ where: { value: userId } });

  afterAll(async () => {
    await prisma.verification.deleteMany({ where: { value: { in: userIds } } });
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  it("stores the hash, never the raw token", async () => {
    const userId = await freshUser();
    const now = new Date();
    const { token } = await issueSetPasswordToken(prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });

    const stored = await rows(userId);
    expect(stored).toHaveLength(1);
    expect(stored[0].identifier).toBe(
      `${SET_PASSWORD_PREFIX}${hashSetPasswordToken(token)}`,
    );
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(hashSetPasswordToken(token)).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["first-sign-in", FIRST_SIGN_IN_TTL_MINUTES, 60],
    ["admin-invite", ADMIN_INVITE_TTL_MINUTES, 10080],
  ] as const)(
    "gives a %s token %i minutes",
    async (kind, minutes, expected) => {
      const userId = await freshUser();
      const now = new Date();
      const issued = await issueSetPasswordToken(prisma, { userId, kind, now });
      expect(issued.expiresInMinutes).toBe(expected);
      expect(minutes).toBe(expected);
      const [row] = await rows(userId);
      expect(row.expiresAt.getTime()).toBe(now.getTime() + expected * 60_000);
    },
  );

  it("leaves one row when issued twice, and the first token dies", async () => {
    const userId = await freshUser();
    const now = new Date();
    const first = await issueSetPasswordToken(prisma, {
      userId,
      kind: "admin-invite",
      now,
    });
    const second = await issueSetPasswordToken(prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });

    expect(await rows(userId)).toHaveLength(1);
    expect(await peekSetPasswordToken(prisma, first.token, now)).toBeNull();
    expect(await peekSetPasswordToken(prisma, second.token, now)).toEqual({
      userId,
    });
  });

  it("peeks without writing", async () => {
    const userId = await freshUser();
    const now = new Date();
    const { token } = await issueSetPasswordToken(prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });
    const before = await rows(userId);

    expect(await peekSetPasswordToken(prisma, token, now)).toEqual({ userId });
    expect(await peekSetPasswordToken(prisma, token, now)).toEqual({ userId });
    expect(await rows(userId)).toEqual(before);
  });

  it("consumes once, and two concurrent consumes give one winner", async () => {
    const userId = await freshUser();
    const now = new Date();
    const { token } = await issueSetPasswordToken(prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });

    const results = await Promise.all([
      consumeSetPasswordToken(prisma, token, now),
      consumeSetPasswordToken(prisma, token, now),
    ]);
    expect(results.filter((r) => r === userId)).toHaveLength(1);
    expect(results.filter((r) => r === null)).toHaveLength(1);
    expect(await rows(userId)).toHaveLength(0);
    expect(await consumeSetPasswordToken(prisma, token, now)).toBeNull();
  });

  it("refuses an expired token and an unknown one", async () => {
    const userId = await freshUser();
    const now = new Date();
    const { token } = await issueSetPasswordToken(prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });
    const later = new Date(now.getTime() + 61 * 60_000);

    expect(await peekSetPasswordToken(prisma, token, later)).toBeNull();
    expect(await consumeSetPasswordToken(prisma, token, later)).toBeNull();
    expect(
      await consumeSetPasswordToken(prisma, "not-a-token", now),
    ).toBeNull();
    expect(await peekSetPasswordToken(prisma, "", now)).toBeNull();
  });

  it("leaves a reset-password row of the same user alone when revoking", async () => {
    const userId = await freshUser();
    const now = new Date();
    await prisma.verification.create({
      data: {
        identifier: "reset-password:other",
        value: userId,
        expiresAt: new Date(now.getTime() + 60_000),
      },
    });
    await issueSetPasswordToken(prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });

    await revokeSetPasswordTokens(prisma, userId);

    const left = await rows(userId);
    expect(left.map((row) => row.identifier)).toEqual(["reset-password:other"]);
  });
});
