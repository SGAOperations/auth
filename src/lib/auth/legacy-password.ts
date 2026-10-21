import "server-only";
import bcrypt from "bcryptjs";
import { verifyPassword as verifyScrypt } from "better-auth/crypto";
import type { PrismaClient } from "@/generated/prisma/client";

// Imported Chambers (Supabase GoTrue) accounts keep their bcrypt hash until the
// user's first sign-in, when it is re-hashed to scrypt. This whole
// module and the `bcryptjs` dependency are removed once the count in
// docs/runbooks/legacy-bcrypt.md stays at zero.

/** Marker the import puts in front of an imported bcrypt hash. */
export const LEGACY_BCRYPT_PREFIX = "bcrypt$";

// GoTrue writes `$2a$`; `$2b$` and `$2y$` are accepted because bcryptjs
// handles them.
const BCRYPT_HASH = /^\$2[aby]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

export function isLegacyBcryptHash(stored: string | null | undefined) {
  return !!stored && stored.startsWith(LEGACY_BCRYPT_PREFIX);
}

/**
 * `emailAndPassword.password.verify`. Routes on the marker: bcrypt for imported
 * hashes, Better Auth's own scrypt for everything else. A malformed imported
 * hash fails closed and never throws, which would turn a sign-in into a 500.
 */
export async function verifyPassword({
  hash,
  password,
}: {
  hash: string;
  password: string;
}) {
  if (!isLegacyBcryptHash(hash)) return verifyScrypt({ hash, password });
  const bcryptHash = hash.slice(LEGACY_BCRYPT_PREFIX.length);
  if (!BCRYPT_HASH.test(bcryptHash)) return false;
  return bcrypt.compare(password, bcryptHash);
}

/**
 * Replaces a user's imported bcrypt hash with a scrypt one, after a sign-in
 * with `password` has succeeded. Returns whether this call did the swap. The
 * update compares against the old hash, so of two concurrent first sign-ins
 * exactly one swaps.
 */
export async function rehashLegacyPassword(
  db: Pick<PrismaClient, "account">,
  {
    userId,
    password,
    hash,
  }: {
    userId: string;
    password: string;
    hash: (password: string) => Promise<string>;
  },
) {
  const account = await db.account.findFirst({
    where: { userId, providerId: "credential", accountId: userId },
    select: { id: true, password: true },
  });
  const stored = account?.password;
  if (!account || !stored || !isLegacyBcryptHash(stored)) return false;

  // A wrong password never re-hashes, whatever the hook wiring does.
  if (!(await verifyPassword({ hash: stored, password }))) return false;

  const next = await hash(password);
  const { count } = await db.account.updateMany({
    where: { id: account.id, password: stored },
    data: { password: next },
  });
  return count === 1;
}

/** How many imported bcrypt hashes remain. */
export function countLegacyBcryptHashes(db: Pick<PrismaClient, "account">) {
  return db.account.count({
    where: {
      providerId: "credential",
      password: { startsWith: LEGACY_BCRYPT_PREFIX },
    },
  });
}
