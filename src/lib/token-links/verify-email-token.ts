import "server-only";
import { createHash } from "node:crypto";
import type { PrismaClient } from "@/generated/prisma/client";

type VerifyTokenDb = Pick<PrismaClient, "usedEmailVerificationToken">;

/** Lower-case hex SHA-256: the only form of a verify token that is stored. */
export function hashVerifyToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

/**
 * Records the token as used. `"claimed"` means this call is the one that may
 * run the verification; `"used"` means an earlier call already did.
 */
export async function claimVerifyToken(
  db: VerifyTokenDb,
  raw: string,
  expiresAt: Date,
  now: Date = new Date(),
): Promise<"claimed" | "used"> {
  // INSERT ... ON CONFLICT DO NOTHING is the atomic single-use guard: of two
  // concurrent claims, exactly one inserts.
  const { count } = await db.usedEmailVerificationToken.createMany({
    data: [{ tokenHash: hashVerifyToken(raw), expiresAt }],
    skipDuplicates: true,
  });
  if (count !== 1) return "used";

  // A row past its `exp` is dead weight: the JWT is already rejected as
  // expired. Pruning here, on a real verification only, needs no scheduled
  // job (ENGINEERING §2).
  await db.usedEmailVerificationToken.deleteMany({
    where: { expiresAt: { lt: now } },
  });
  return "claimed";
}

/**
 * Removes the claim when the verification did not happen, so the person can
 * retry the same link.
 */
export async function releaseVerifyToken(
  db: VerifyTokenDb,
  raw: string,
): Promise<void> {
  await db.usedEmailVerificationToken.deleteMany({
    where: { tokenHash: hashVerifyToken(raw) },
  });
}

/**
 * Verify tokens are stateless JWTs, so the ones already mailed for an account
 * are revoked by a cutoff instead: a `Verification` row whose `createdAt` is
 * the moment of revocation. Any token issued at or before it is refused. The
 * value is the user id, so a tombstone and an email change remove the row.
 */
export const VERIFY_CUTOFF_PREFIX = "verify-cutoff:";

type CutoffDb = Pick<PrismaClient, "verification">;

/**
 * Makes every verify token issued for the user until `now` unusable. The row
 * outlives the longest token, then the retention job purges it as expired.
 */
export async function revokeVerifyTokensBefore(
  db: CutoffDb,
  {
    userId,
    now,
    ttlSeconds,
  }: { userId: string; now: Date; ttlSeconds: number },
): Promise<void> {
  const identifier = `${VERIFY_CUTOFF_PREFIX}${userId}`;
  await db.verification.deleteMany({ where: { identifier } });
  await db.verification.create({
    data: {
      identifier,
      value: userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + ttlSeconds * 1000),
    },
  });
}

/**
 * Whether a token for `email` issued at `issuedAt` (the JWT's `iat`, in whole
 * seconds) falls at or before the account's cutoff. A token from the same
 * second as the cutoff is refused too: `iat` cannot say which came first.
 */
export async function isVerifyTokenRevoked(
  db: CutoffDb & Pick<PrismaClient, "user">,
  { email, issuedAt }: { email: string; issuedAt: number },
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { email },
    select: { id: true },
  });
  if (!user) return false;
  const cutoff = await db.verification.findFirst({
    where: { identifier: `${VERIFY_CUTOFF_PREFIX}${user.id}` },
    select: { createdAt: true },
  });
  return (
    cutoff !== null && issuedAt <= Math.floor(cutoff.createdAt.getTime() / 1000)
  );
}

/** Read-only: the GET page uses this and never claims. */
export async function isVerifyTokenUsed(
  db: VerifyTokenDb,
  raw: string,
): Promise<boolean> {
  const row = await db.usedEmailVerificationToken.findUnique({
    where: { tokenHash: hashVerifyToken(raw) },
    select: { tokenHash: true },
  });
  return row !== null;
}
