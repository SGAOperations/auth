import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { PrismaPg } from "@prisma/adapter-pg";
import { Prisma, PrismaClient } from "@/generated/prisma/client";

const url = process.env.TEST_DATABASE_URL;

const DAY_MS = 24 * 60 * 60 * 1000;
const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe.skipIf(!url)("core identity schema", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL, and
  // config.ts parses the app environment. Options mirror config.ts.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth({
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    advanced: { database: { generateId: false } },
    emailAndPassword: { enabled: true },
    secret: "s".repeat(32),
    baseURL: "http://localhost:3000",
  });

  const rand = Math.random().toString(36).slice(2, 10);
  const verificationIdentifier = `t10-verification-${rand}`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.verification.deleteMany({
      where: { identifier: verificationIdentifier },
    });
    await prisma.$disconnect();
  });

  it("round-trips User, Account and Session through Better Auth", async () => {
    const email = `T10-RoundTrip-${rand}@Northeastern.edu`;
    const password = "correct-horse-battery-staple";

    await auth.api.signUpEmail({
      body: { email, password, name: "Round Trip" },
    });

    const user = await prisma.user.findUniqueOrThrow({
      where: { email: email.toLowerCase() },
    });
    expect(user.email).toBe(email.toLowerCase());
    expect(user.status).toBe("ACTIVE");
    expect(user.isAdmin).toBe(false);
    expect(user.id).toMatch(UUID_V7);

    const accounts = await prisma.account.findMany({
      where: { userId: user.id },
    });
    expect(accounts).toHaveLength(1);
    expect(accounts[0].providerId).toBe("credential");
    expect(accounts[0].password).not.toBeNull();

    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(sessions).toHaveLength(1);
    const span =
      sessions[0].absoluteExpiresAt.getTime() - sessions[0].createdAt.getTime();
    expect(Math.abs(span - 90 * DAY_MS)).toBeLessThan(5000);

    const signedIn = await auth.api.signInEmail({ body: { email, password } });
    expect(signedIn.user.id).toBe(user.id);
  });

  it("round-trips Verification through the Better Auth adapter", async () => {
    const ctx = await auth.$context;
    const expiresAt = new Date(Date.now() + DAY_MS);
    await ctx.internalAdapter.createVerificationValue({
      identifier: verificationIdentifier,
      value: "token-value",
      expiresAt,
    });
    const found = await ctx.internalAdapter.findVerificationValue(
      verificationIdentifier,
    );
    expect(found?.value).toBe("token-value");
  });

  it("treats emails as case-insensitively unique", async () => {
    const data = { name: "Alice" };
    await prisma.user.create({
      data: { ...data, email: `Alice-${rand}@Northeastern.edu` },
    });
    const duplicate = prisma.user.create({
      data: { ...data, email: `alice-${rand}@northeastern.edu` },
    });
    await expect(duplicate).rejects.toMatchObject({
      code: "P2002",
    });
    await expect(duplicate).rejects.toBeInstanceOf(
      Prisma.PrismaClientKnownRequestError,
    );
  });

  it("rejects a Primary Admin who is not an admin", async () => {
    const create = prisma.user.create({
      data: {
        email: `check-${rand}@northeastern.edu`,
        name: "Check",
        isPrimaryAdmin: true,
        isAdmin: false,
      },
    });
    await expect(create).rejects.toThrow("User_primaryAdmin_requires_admin");
  });

  it("creates the required indexes", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE schemaname = 'public'`;
    const names = rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "Session_userId_idx",
        "Session_expiresAt_idx",
        "Account_userId_idx",
        "Verification_identifier_idx",
        "User_email_key",
        "Session_token_key",
      ]),
    );
  });
});
