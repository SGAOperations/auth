import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { hashPassword, verifyPassword } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import {
  LEGACY_BCRYPT_PREFIX,
  countLegacyBcryptHashes,
  rehashLegacyPassword,
} from "@/lib/auth/legacy-password";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const CHAMBERS_PW = "chambers-pw-1";

describe.skipIf(!url)("imported bcrypt hashes", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth(
    buildAuthOptions({ prisma, baseURL: BASE_URL, secret: SECRET }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  // Audit rows cannot be deleted, so assertions filter by user id.
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  // The shape the import writes.
  async function importedUser({
    emailVerified = true,
    status = "ACTIVE",
  }: { emailVerified?: boolean; status?: "ACTIVE" | "DEACTIVATED" } = {}) {
    const email = `t21-${counter++}-${rand}@northeastern.edu`;
    const user = await prisma.user.create({
      data: { email, name: "Imported", emailVerified, status },
    });
    await prisma.account.create({
      data: {
        userId: user.id,
        accountId: user.id,
        providerId: "credential",
        password: LEGACY_BCRYPT_PREFIX + bcrypt.hashSync(CHAMBERS_PW, 4),
      },
    });
    return { email, user };
  }

  function post(email: string, password: string) {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  async function storedHash(userId: string) {
    const account = await prisma.account.findFirstOrThrow({
      where: { userId, providerId: "credential" },
    });
    return account.password;
  }

  function rehashEvents(userId: string) {
    return prisma.auditEvent.findMany({
      where: { type: "PASSWORD_REHASHED", targetId: userId },
    });
  }

  it("re-hashes to scrypt on the first sign-in, once", async () => {
    const { email, user } = await importedUser();
    const before = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    const count = await countLegacyBcryptHashes(prisma);

    const first = await post(email, CHAMBERS_PW);
    expect(first.status).toBe(200);

    const hash = await storedHash(user.id);
    expect(hash).not.toMatch(/^bcrypt\$/);
    expect(await verifyPassword({ hash: hash!, password: CHAMBERS_PW })).toBe(
      true,
    );
    expect(await countLegacyBcryptHashes(prisma)).toBe(count - 1);

    const events = await rehashEvents(user.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "USER",
      actorUserId: user.id,
      targetType: "USER",
    });

    const after = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.passwordChangedAt).toEqual(before.passwordChangedAt);

    expect((await post(email, CHAMBERS_PW)).status).toBe(200);
    expect(await rehashEvents(user.id)).toHaveLength(1);
  });

  it("does not re-hash after a wrong password", async () => {
    const { email, user } = await importedUser();
    const before = await storedHash(user.id);

    const response = await post(email, "not-the-password");
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
    expect(await storedHash(user.id)).toBe(before);
    expect(await rehashEvents(user.id)).toHaveLength(0);

    expect((await post(email, CHAMBERS_PW)).status).toBe(200);
  });

  it("does not re-hash an unverified or a deactivated user", async () => {
    const unverified = await importedUser({ emailVerified: false });
    const unverifiedHash = await storedHash(unverified.user.id);
    const r1 = await post(unverified.email, CHAMBERS_PW);
    expect(r1.status).toBe(403);
    expect(await r1.json()).toMatchObject({ code: "EMAIL_NOT_VERIFIED" });
    expect(await storedHash(unverified.user.id)).toBe(unverifiedHash);

    const deactivated = await importedUser({ status: "DEACTIVATED" });
    const deactivatedHash = await storedHash(deactivated.user.id);
    const r2 = await post(deactivated.email, CHAMBERS_PW);
    expect(r2.status).toBe(403);
    expect(await r2.json()).toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
    expect(await storedHash(deactivated.user.id)).toBe(deactivatedHash);

    expect(await rehashEvents(unverified.user.id)).toHaveLength(0);
    expect(await rehashEvents(deactivated.user.id)).toHaveLength(0);
  });

  it("answers a malformed hash like a wrong password", async () => {
    const { email, user } = await importedUser();
    await prisma.account.updateMany({
      where: { userId: user.id },
      data: { password: "bcrypt$not-a-hash" },
    });

    const response = await post(email, CHAMBERS_PW);
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "INVALID_EMAIL_OR_PASSWORD",
    });
  });

  it("lets exactly one of two concurrent re-hashes win", async () => {
    const { user } = await importedUser();
    const results = await Promise.all([
      rehashLegacyPassword(prisma, {
        userId: user.id,
        password: CHAMBERS_PW,
        hash: hashPassword,
      }),
      rehashLegacyPassword(prisma, {
        userId: user.id,
        password: CHAMBERS_PW,
        hash: hashPassword,
      }),
    ]);

    expect(results.filter(Boolean)).toHaveLength(1);
    expect(await storedHash(user.id)).not.toMatch(/^bcrypt\$/);
  });
});
