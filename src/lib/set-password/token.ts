import "server-only";
import { createHash, randomBytes } from "node:crypto";
import type { Prisma } from "@/generated/prisma/client";

type SetPasswordTokenDb = Pick<Prisma.TransactionClient, "verification">;

// Set-password tokens live in Better Auth's `Verification` table, so they need
// no migration. `identifier` is the prefix plus the SHA-256 of the raw token,
// which is therefore never stored, and `value` is the user id.
export const SET_PASSWORD_PREFIX = "set-password:";

/** One hour, per AUTH-T22. */
export const FIRST_SIGN_IN_TTL_MINUTES = 60;
/** Seven days, per AUTH-T22. */
export const ADMIN_INVITE_TTL_MINUTES = 7 * 24 * 60;

export type SetPasswordKind = "first-sign-in" | "admin-invite";

const TTL_MINUTES: Record<SetPasswordKind, number> = {
  "first-sign-in": FIRST_SIGN_IN_TTL_MINUTES,
  "admin-invite": ADMIN_INVITE_TTL_MINUTES,
};

/** Lower-case hex SHA-256: the only form of a token that is ever stored. */
export function hashSetPasswordToken(raw: string): string {
  return createHash("sha256").update(raw).digest("hex");
}

function identifierFor(raw: string): string {
  return `${SET_PASSWORD_PREFIX}${hashSetPasswordToken(raw)}`;
}

/**
 * Replaces the user's outstanding set-password links with a fresh one, so only
 * the newest link works. Returns the raw token for the email link. It is never
 * logged or persisted.
 */
export async function issueSetPasswordToken(
  db: SetPasswordTokenDb,
  { userId, kind, now }: { userId: string; kind: SetPasswordKind; now: Date },
): Promise<{ token: string; expiresInMinutes: number }> {
  const expiresInMinutes = TTL_MINUTES[kind];
  const token = randomBytes(32).toString("base64url");
  await revokeSetPasswordTokens(db, userId);
  await db.verification.create({
    data: {
      identifier: identifierFor(token),
      value: userId,
      expiresAt: new Date(now.getTime() + expiresInMinutes * 60_000),
    },
  });
  return { token, expiresInMinutes };
}

/**
 * Read-only, for the GET page. Unknown, expired and malformed tokens all
 * return `null`, so a caller cannot tell them apart.
 */
export async function peekSetPasswordToken(
  db: SetPasswordTokenDb,
  raw: string,
  now: Date,
): Promise<{ userId: string } | null> {
  const row = await db.verification.findFirst({
    where: { identifier: identifierFor(raw), expiresAt: { gt: now } },
    select: { value: true },
  });
  return row ? { userId: row.value } : null;
}

/** Returns the token's `userId` and spends it, or `null`. */
export async function consumeSetPasswordToken(
  db: SetPasswordTokenDb,
  raw: string,
  now: Date,
): Promise<string | null> {
  const row = await db.verification.findFirst({
    where: { identifier: identifierFor(raw) },
    select: { id: true, value: true },
  });
  if (!row) return null;
  // The conditional delete is the atomic single-use guard: of two concurrent
  // consumes, exactly one deletes the row.
  const { count } = await db.verification.deleteMany({
    where: { id: row.id, expiresAt: { gt: now } },
  });
  return count === 1 ? row.value : null;
}

/** Deletes every outstanding set-password link of the user. */
export async function revokeSetPasswordTokens(
  db: SetPasswordTokenDb,
  userId: string,
): Promise<void> {
  await db.verification.deleteMany({
    where: {
      value: userId,
      identifier: { startsWith: SET_PASSWORD_PREFIX },
    },
  });
}
