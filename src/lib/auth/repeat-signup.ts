import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { VERIFICATION_TOKEN_TTL_SECONDS } from "@/lib/auth/policy";
import { revokeVerifyTokensBefore } from "@/lib/token-links/verify-email-token";

// The red-team B2 pre-hijack fix (AUTH-T17, black-team BT1). Anyone can sign up
// someone else's address first, choosing the password; the account stays
// unverified until a verify link is used. A verify link proves the mailbox, so
// it must never confirm a password the mailbox owner did not choose.
//
// So a repeat sign-up for an unverified account with a password writes neither
// party's password. It removes the password, the sessions and the passkeys and
// revokes every verify link already mailed for the account. The account is then
// password-less, so `onExistingUserSignUp` mails it a set-password link
// (AUTH-T22), and consuming that link verifies the address. Whoever holds the
// mailbox picks the password, however many times either party signs up. The
// answer stays Better Auth's generic duplicate response, so nothing tells an
// existing address from a new one.
//
// Left as is: the owner can still click an unsolicited verify link for an
// account someone else created, before any repeat sign-up. That is inherent to
// sign-up-then-verify; the verify page tells them not to.

/**
 * Strips an unverified, ACTIVE account of its password and everything that
 * hangs off it. Returns whether it did. A verified or inactive account, or one
 * with no password, is left alone.
 */
export async function reclaimUnverifiedAccount(
  prisma: Pick<PrismaClient, "$transaction">,
  { userId, now = new Date() }: { userId: string; now?: Date },
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    // A conditional write, so the user row stays locked until the commit and a
    // verification that lands first wins.
    const claimed = await tx.user.updateMany({
      where: { id: userId, emailVerified: false, status: "ACTIVE" },
      data: { updatedAt: now },
    });
    if (claimed.count === 0) return false;
    const { count } = await tx.account.updateMany({
      where: { userId, providerId: "credential", password: { not: null } },
      data: { password: null },
    });
    if (count === 0) return false;
    await tx.passkey.deleteMany({ where: { userId } });
    await tx.session.deleteMany({ where: { userId } });
    await revokeVerifyTokensBefore(tx, {
      userId,
      now,
      ttlSeconds: VERIFICATION_TOKEN_TTL_SECONDS,
    });
    return true;
  });
}
