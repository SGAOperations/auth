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
