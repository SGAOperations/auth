import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  claimVerifyToken,
  hashVerifyToken,
  isVerifyTokenUsed,
  releaseVerifyToken,
} from "@/lib/token-links/verify-email-token";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const HOUR_MS = 60 * 60 * 1000;

describe("hashVerifyToken", () => {
  it("matches the known SHA-256 vector", () => {
    expect(hashVerifyToken("abc")).toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
  });
});

describe.skipIf(!url)("verify-token single-use record", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const rand = Math.random().toString(36).slice(2, 10);
  const future = () => new Date(Date.now() + HOUR_MS);
  const created: string[] = [];

  function token(label: string) {
    const raw = `t103-${label}-${rand}`;
    created.push(hashVerifyToken(raw));
    return raw;
  }

  afterAll(async () => {
    await prisma.usedEmailVerificationToken.deleteMany({
      where: { tokenHash: { in: created } },
    });
    await prisma.$disconnect();
  });

  it("claims once, stores only the hash, then reports used", async () => {
    const raw = token("once");
    expect(await claimVerifyToken(prisma, raw, future())).toBe("claimed");
    expect(await claimVerifyToken(prisma, raw, future())).toBe("used");

    expect(await isVerifyTokenUsed(prisma, raw)).toBe(true);
    expect(
      await prisma.usedEmailVerificationToken.count({
        where: { tokenHash: raw },
      }),
    ).toBe(0);
    const row = await prisma.usedEmailVerificationToken.findUniqueOrThrow({
      where: { tokenHash: hashVerifyToken(raw) },
    });
    expect(row.tokenHash).toBe(hashVerifyToken(raw));
  });

  it("lets exactly one of two concurrent claims win", async () => {
    const raw = token("race");
    const results = await Promise.all([
      claimVerifyToken(prisma, raw, future()),
      claimVerifyToken(prisma, raw, future()),
    ]);
    expect(results.filter((r) => r === "claimed")).toHaveLength(1);
    expect(results.filter((r) => r === "used")).toHaveLength(1);
  });

  it("allows a claim again after a release", async () => {
    const raw = token("release");
    await claimVerifyToken(prisma, raw, future());
    await releaseVerifyToken(prisma, raw);
    expect(await isVerifyTokenUsed(prisma, raw)).toBe(false);
    expect(await claimVerifyToken(prisma, raw, future())).toBe("claimed");
  });

  it("reports an unknown token as unused without writing", async () => {
    const raw = token("unknown");
    expect(await isVerifyTokenUsed(prisma, raw)).toBe(false);
    expect(
      await prisma.usedEmailVerificationToken.count({
        where: { tokenHash: hashVerifyToken(raw) },
      }),
    ).toBe(0);
  });

  it("prunes expired rows on a claim and keeps unexpired ones", async () => {
    const expired = token("expired");
    const kept = token("kept");
    await prisma.usedEmailVerificationToken.createMany({
      data: [
        {
          tokenHash: hashVerifyToken(expired),
          expiresAt: new Date(Date.now() - HOUR_MS),
        },
        { tokenHash: hashVerifyToken(kept), expiresAt: future() },
      ],
    });

    await claimVerifyToken(prisma, token("prune"), future());

    expect(await isVerifyTokenUsed(prisma, expired)).toBe(false);
    expect(await isVerifyTokenUsed(prisma, kept)).toBe(true);
  });

  it("rejects a non-hex tokenHash with the CHECK constraint", async () => {
    await expect(
      prisma.usedEmailVerificationToken.create({
        data: { tokenHash: `not-hex-${rand}`, expiresAt: future() },
      }),
    ).rejects.toThrow();
  });
});
