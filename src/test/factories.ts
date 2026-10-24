import { randomBytes } from "node:crypto";
import { hashPassword } from "better-auth/crypto";
import type { Prisma } from "@/generated/prisma/client";
import { prisma } from "@/lib/prisma";

const DAY_MS = 24 * 60 * 60 * 1000;

// Unique per process and per call, so files and reruns never collide.
const suffix = randomBytes(4).toString("hex");
let counter = 0;
function next(): number {
  counter += 1;
  return counter;
}

type CreateUserOverrides = Partial<Prisma.UserUncheckedCreateInput> & {
  password?: string;
};

/**
 * ACTIVE, email-verified, non-admin user with a unique @northeastern.edu email.
 * Passing `password` also creates the credential Account Better Auth signs in with.
 */
export async function createUser(
  overrides: CreateUserOverrides = {},
  db: Prisma.TransactionClient = prisma,
) {
  const { password, ...data } = overrides;
  const n = next();
  const user = await db.user.create({
    data: {
      email: `user-${n}-${suffix}@northeastern.edu`,
      name: `Test User ${n}`,
      emailVerified: true,
      status: "ACTIVE",
      ...data,
    },
  });
  if (password !== undefined) {
    await db.account.create({
      data: {
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: await hashPassword(password),
      },
    });
  }
  return user;
}

/** createUser with `isAdmin: true`. */
export function createAdmin(
  overrides: CreateUserOverrides = {},
  db: Prisma.TransactionClient = prisma,
) {
  return createUser({ isAdmin: true, ...overrides }, db);
}

/**
 * createUser with `isAdmin` and `isPrimaryAdmin`, after displacing any existing
 * Primary Admin (the harness one, see `ensureHarnessPrimaryAdmin`) inside `db`.
 *
 * `db` must be the client of a transaction that rolls back: a Primary Admin can
 * never be deleted, so a committed one would stay for good. The displacement
 * runs on `db`, so it lasts for that transaction only.
 */
export async function createPrimaryAdmin(
  overrides: CreateUserOverrides,
  db: Prisma.TransactionClient,
) {
  await db.$executeRaw`SELECT set_config('sgauth.pa_transfer', 'on', true)`;
  await db.user.updateMany({
    where: { isPrimaryAdmin: true },
    data: { isPrimaryAdmin: false },
  });
  await db.$executeRaw`SELECT set_config('sgauth.pa_transfer', 'off', true)`;
  return createUser({ isAdmin: true, isPrimaryAdmin: true, ...overrides }, db);
}

/**
 * Session with a random token, a 30-day `expiresAt` and a 90-day
 * `absoluteExpiresAt`, both measured from `Date.now()` so a fake clock drives
 * them (the database default would use real time).
 */
export function createSession(
  user: { id: string },
  overrides: Partial<Prisma.SessionUncheckedCreateInput> = {},
) {
  const now = Date.now();
  return prisma.session.create({
    data: {
      token: randomBytes(32).toString("base64url"),
      expiresAt: new Date(now + 30 * DAY_MS),
      absoluteExpiresAt: new Date(now + 90 * DAY_MS),
      ...overrides,
      userId: user.id,
    },
  });
}

/**
 * Active position with a unique kebab-case `key` and name, no category and no
 * holders. Assign holders by creating UserPosition rows directly.
 */
export function createPosition(
  overrides: Partial<Prisma.PositionUncheckedCreateInput> = {},
) {
  const n = next();
  return prisma.position.create({
    data: {
      key: `test-position-${n}-${suffix}`,
      name: `Test Position ${n}`,
      ...overrides,
    },
  });
}
