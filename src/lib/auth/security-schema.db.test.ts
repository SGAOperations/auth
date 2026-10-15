import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { jwt, twoFactor } from "better-auth/plugins";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("security tables", () => {
  // Own client and auth instance, as in schema.db.test.ts. The plugins are only
  // declared here to prove the tables fit; config.ts wires them in AUTH-T29
  // (jwt) and AUTH-T67 (twoFactor).
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    advanced: { database: { generateId: false } },
    emailAndPassword: { enabled: true },
    secret: "s".repeat(32),
    baseURL: "http://localhost:3000",
    plugins: [jwt(), twoFactor()],
  });

  const rand = Math.random().toString(36).slice(2, 10);
  let preexistingJwks: string[] = [];

  beforeAll(async () => {
    const rows = await prisma.jwks.findMany({ select: { id: true } });
    preexistingJwks = rows.map((row) => row.id);
  });

  async function createUser(label: string) {
    return prisma.user.create({
      data: { email: `t15-${label}-${rand}@northeastern.edu`, name: label },
    });
  }

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.jwks.deleteMany({ where: { id: { notIn: preexistingJwks } } });
    await prisma.$disconnect();
  });

  it("stores the jwt plugin's signing keys in Jwks", async () => {
    const { keys } = await auth.api.getJwks();
    expect(keys.length).toBeGreaterThan(0);

    for (const key of keys) {
      const row = await prisma.jwks.findUniqueOrThrow({
        where: { id: key.kid },
      });
      expect(row.publicKey).not.toBe("");
      expect(row.privateKey).not.toBe("");
    }
  });

  it("stores the twoFactor plugin's enrolment in TwoFactor", async () => {
    const email = `t15-totp-${rand}@northeastern.edu`;
    const password = "correct-horse-battery-staple";
    const signUp = await auth.api.signUpEmail({
      body: { email, password, name: "Totp" },
      asResponse: true,
    });
    const cookie = signUp.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");

    await auth.api.enableTwoFactor({
      body: { password },
      headers: new Headers({ cookie }),
    });

    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    const rows = await prisma.twoFactor.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].secret).not.toBe("");
    expect(rows[0].backupCodes).not.toBe("");
  });

  it("rejects an UnlockToken whose hash is not lower-case hex SHA-256", async () => {
    const user = await createUser("check-token");
    const create = prisma.unlockToken.create({
      data: {
        userId: user.id,
        tokenHash: "not-a-hash",
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
    await expect(create).rejects.toThrow("UnlockToken_tokenHash_sha256_hex");
  });

  it("rejects an AccountLock with a negative counter", async () => {
    const user = await createUser("check-lock");
    const create = prisma.accountLock.create({
      data: { userId: user.id, failedCount: -1 },
    });
    await expect(create).rejects.toThrow("AccountLock_counters_nonnegative");
  });

  it("defaults AccountLock and keeps one row per user", async () => {
    const user = await createUser("lock-defaults");
    const lock = await prisma.accountLock.create({
      data: { userId: user.id },
    });
    expect(lock.failedCount).toBe(0);
    expect(lock.lockLevel).toBe(0);
    expect(lock.windowStartedAt).toBeInstanceOf(Date);
    expect(lock.lockedUntil).toBeNull();

    const duplicate = prisma.accountLock.create({ data: { userId: user.id } });
    await expect(duplicate).rejects.toMatchObject({ code: "P2002" });
    await expect(duplicate).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("has no rate-limit table", async () => {
    const rows = await prisma.$queryRaw<{ tablename: string }[]>`
      SELECT tablename FROM pg_tables WHERE schemaname = 'public'`;
    const names = rows.map((row) => row.tablename.toLowerCase());
    expect(names).not.toContain("ratelimit");
  });

  it("creates the required indexes", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "UnlockToken_tokenHash_key",
        "UnlockToken_userId_idx",
        "TwoFactor_userId_idx",
        "TwoFactor_secret_idx",
      ]),
    );
  });
});
