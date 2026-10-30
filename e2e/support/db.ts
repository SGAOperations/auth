import { PrismaPg } from "@prisma/adapter-pg";
import { hashPassword } from "better-auth/crypto";
import { PrismaClient } from "../../src/generated/prisma/client";

// Fixture access for the e2e suite. It builds its own client, the same
// exception prisma/seed.ts has from the "one Prisma client" rule: the app's
// src/lib/prisma.ts imports `server-only`, which Playwright cannot load.

export const MEMBER_EMAIL = "e2e-member@e2e.invalid";
export const ADMIN_EMAIL = "e2e-admin@e2e.invalid";
// A second plain user for open-redirect.spec.ts: the sign-in email step allows
// 5 attempts per address per 10 minutes, and the two specs together exceed it.
export const REDIRECT_EMAIL = "e2e-redirect@e2e.invalid";
export const PRODUCT_B_POSITION = "e2e-product-b-access";
// Not a secret: it only ever hashes into a local or CI database.
export const E2E_PASSWORD = "e2e-only-password-0123";

let client: PrismaClient | undefined;

function db(): PrismaClient {
  if (client === undefined) {
    const connectionString = process.env.DATABASE_URL;
    if (connectionString === undefined || connectionString === "") {
      throw new Error("DATABASE_URL is required to run the e2e fixtures");
    }
    client = new PrismaClient({ adapter: new PrismaPg({ connectionString }) });
  }
  return client;
}

async function upsertUser(email: string, name: string, isAdmin: boolean) {
  const prisma = db();
  const user = await prisma.user.upsert({
    where: { email },
    update: {
      name,
      isAdmin,
      emailVerified: true,
      status: "ACTIVE",
      deactivatedAt: null,
      deletedAt: null,
    },
    create: { email, name, isAdmin, emailVerified: true, status: "ACTIVE" },
    select: { id: true },
  });
  const password = await hashPassword(E2E_PASSWORD);
  await prisma.account.upsert({
    where: {
      providerId_accountId: { providerId: "credential", accountId: user.id },
    },
    update: { password, userId: user.id },
    create: {
      providerId: "credential",
      accountId: user.id,
      userId: user.id,
      password,
    },
  });
  return user.id;
}

/**
 * Upserts the three fixture users and the position, then wipes their sessions and
 * position grants, so every run starts signed out and without the position.
 * Users are never deleted.
 */
export async function seedUsers(): Promise<void> {
  const prisma = db();
  const memberId = await upsertUser(MEMBER_EMAIL, "E2E Member", false);
  const adminId = await upsertUser(ADMIN_EMAIL, "E2E Admin", true);
  const redirectId = await upsertUser(REDIRECT_EMAIL, "E2E Redirect", false);

  const existing = await prisma.position.findFirst({
    where: { key: PRODUCT_B_POSITION, deletedAt: null },
    select: { id: true },
  });
  if (existing === null) {
    await prisma.position.create({
      data: {
        key: PRODUCT_B_POSITION,
        name: "E2E product B access",
        createdById: adminId,
        updatedById: adminId,
      },
    });
  }

  const userIds = [memberId, adminId, redirectId];
  await prisma.session.deleteMany({ where: { userId: { in: userIds } } });
  await prisma.userPosition.deleteMany({ where: { userId: { in: userIds } } });
}

/** Grants `key` to the user, recorded as assigned by the e2e admin. */
export async function assignPosition(
  email: string,
  key: string,
): Promise<void> {
  const prisma = db();
  const [user, admin, position] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email }, select: { id: true } }),
    prisma.user.findUniqueOrThrow({
      where: { email: ADMIN_EMAIL },
      select: { id: true },
    }),
    prisma.position.findFirstOrThrow({
      where: { key, deletedAt: null },
      select: { id: true },
    }),
  ]);
  await prisma.userPosition.create({
    data: { userId: user.id, positionId: position.id, assignedById: admin.id },
  });
}

/** Sets every session of the user to expire a minute ago. */
export async function expireSessions(email: string): Promise<void> {
  const prisma = db();
  await prisma.session.updateMany({
    where: { user: { email } },
    data: { expiresAt: new Date(Date.now() - 60_000) },
  });
}

export async function disconnect(): Promise<void> {
  if (client === undefined) return;
  await client.$disconnect();
  client = undefined;
}
