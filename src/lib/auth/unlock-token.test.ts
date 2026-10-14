import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  consumeUnlockToken,
  hashUnlockToken,
  issueUnlockToken,
} from "@/lib/auth/unlock-token";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const HOUR_MS = 60 * 60 * 1000;

describe("hashUnlockToken", () => {
  it("matches the known SHA-256 vector", () => {
    expect(hashUnlockToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });

  it("is lower-case hex and deterministic", () => {
    const hash = hashUnlockToken("some-token");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
    expect(hashUnlockToken("some-token")).toBe(hash);
  });
});

describe.skipIf(!url)("unlock tokens in the database", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const rand = Math.random().toString(36).slice(2, 10);

  async function createUser(label: string) {
    return prisma.user.create({
      data: { email: `t15-${label}-${rand}@northeastern.edu`, name: label },
    });
  }

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  it("stores only the hash of the raw token", async () => {
    const user = await createUser("hash");
    const raw = await issueUnlockToken(prisma, user.id);

    const rows = await prisma.unlockToken.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].tokenHash).toBe(hashUnlockToken(raw));
    expect(rows[0].tokenHash).not.toBe(raw);
    expect(await prisma.unlockToken.count({ where: { tokenHash: raw } })).toBe(
      0,
    );
  });

  it("consumes a token once", async () => {
    const user = await createUser("single");
    const raw = await issueUnlockToken(prisma, user.id);

    expect(await consumeUnlockToken(prisma, raw)).toBe(user.id);
    const row = await prisma.unlockToken.findUniqueOrThrow({
      where: { tokenHash: hashUnlockToken(raw) },
    });
    expect(row.usedAt).not.toBeNull();
    expect(await consumeUnlockToken(prisma, raw)).toBeNull();
  });

  it("lets exactly one of two concurrent consumes win", async () => {
    const user = await createUser("race");
    const raw = await issueUnlockToken(prisma, user.id);

    const results = await Promise.all([
      consumeUnlockToken(prisma, raw),
      consumeUnlockToken(prisma, raw),
    ]);
    expect(results.filter((id) => id === user.id)).toHaveLength(1);
    expect(results.filter((id) => id === null)).toHaveLength(1);
  });

  it("treats an expired token as unknown", async () => {
    const user = await createUser("expired");
    const raw = await issueUnlockToken(
      prisma,
      user.id,
      new Date(Date.now() - 2 * HOUR_MS),
    );
    expect(await consumeUnlockToken(prisma, raw)).toBeNull();
  });

  it("returns null for an unknown token", async () => {
    expect(await consumeUnlockToken(prisma, `unknown-${rand}`)).toBeNull();
  });
});
