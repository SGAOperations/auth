import "server-only";
import { createHash } from "node:crypto";
import type { BetterAuthOptions } from "better-auth";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import type { Mailer } from "@/lib/email/mailer";
import { tokenLinkUrl } from "@/lib/token-links/actions";

// Better Auth's own reset (`/request-password-reset`, `/reset-password`)
// supplies the token; this module supplies SGAuth's side of it (ENGINEERING §1).

export const RESET_PASSWORD_TOKEN_TTL_SECONDS = 3600;

/** Must equal the literal in Better Auth's `password.mjs`; the DB test guards it. */
export const RESET_PASSWORD_IDENTIFIER_PREFIX = "reset-password:";

/**
 * Reset tokens are hashed at rest, scoped by prefix so no other Verification
 * flow changes. Better Auth hashes the presented token and compares hashes.
 */
export const RESET_PASSWORD_VERIFICATION_STORAGE = {
  default: "plain",
  overrides: { [RESET_PASSWORD_IDENTIFIER_PREFIX]: "hashed" },
} satisfies NonNullable<BetterAuthOptions["verification"]>["storeIdentifier"];

/**
 * The `Verification.identifier` Better Auth stores for a reset token:
 * base64url SHA-256 of the full prefixed identifier, with no padding. Used only
 * to find a row; Better Auth still writes and consumes it.
 */
export function resetTokenStoredIdentifier(token: string): string {
  return createHash("sha256")
    .update(RESET_PASSWORD_IDENTIFIER_PREFIX + token)
    .digest("base64url");
}

/**
 * Whether a link's token is a live reset token. Read-only on purpose: it does
 * not go through Better Auth's lookup, which deletes an expired row, so a
 * scanner pre-fetch of the page changes nothing.
 */
export async function isResetTokenUsable(
  db: Pick<PrismaClient, "verification">,
  token: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await db.verification.findFirst({
    where: {
      identifier: resetTokenStoredIdentifier(token),
      expiresAt: { gt: now },
    },
    select: { id: true },
  });
  return row !== null;
}

const resetUser = z.looseObject({
  email: z.string(),
  name: z.string().nullish(),
  status: z.string(),
});

/**
 * Better Auth's `sendResetPassword`. It answers the request the same for every
 * address, so a deactivated account simply gets no mail. Ignores Better Auth's
 * `url`, which points at its GET endpoint, and links to the scanner-safe page.
 * A send failure is logged without the error or the address.
 */
export function createSendResetPassword({
  mailer,
  linkOrigin,
  logger,
}: {
  mailer: Pick<Mailer, "sendEmail">;
  linkOrigin: string;
  logger: {
    error: (message: string, fields?: Record<string, unknown>) => void;
  };
}) {
  return async function sendResetPassword({
    user,
    token,
  }: {
    user: unknown;
    token: string;
  }): Promise<void> {
    const parsed = resetUser.safeParse(user);
    if (!parsed.success || parsed.data.status !== "ACTIVE") return;
    try {
      await mailer.sendEmail({
        to: parsed.data.email,
        template: "reset-password",
        data: {
          name: parsed.data.name || undefined,
          url: tokenLinkUrl(linkOrigin, "reset-password", token),
          expiresInMinutes: RESET_PASSWORD_TOKEN_TTL_SECONDS / 60,
        },
      });
    } catch (error) {
      logger.error("password_reset_email_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  };
}

interface ResetHookUser {
  id: string;
  email: string;
  name?: string | null;
}

/**
 * Better Auth's `onPasswordReset`, which runs before its own session
 * revocation. A throw there would skip it, so every session is deleted first.
 * The reset is unauthenticated, so "all other sessions" means all of them.
 *
 * Failing before the password-changed stamp is safe: the sessions are already
 * gone. After it, `afterReset` (audit, lock clear, analytics) logs and
 * continues on its own, and a failed notice never fails a committed reset.
 */
export function createOnPasswordReset({
  prisma,
  mailer,
  afterReset,
  now = () => new Date(),
}: {
  prisma: Pick<PrismaClient, "session" | "user">;
  mailer: Pick<Mailer, "sendEmail">;
  afterReset: (
    data: { user: ResetHookUser },
    request?: Request,
  ) => Promise<void>;
  now?: () => Date;
}) {
  return async function onPasswordReset(
    data: { user: ResetHookUser },
    request?: Request,
  ): Promise<void> {
    const { user } = data;
    await prisma.session.deleteMany({ where: { userId: user.id } });

    const at = now();
    await prisma.user.update({
      where: { id: user.id },
      data: { passwordChangedAt: at },
    });

    await afterReset(data, request);

    try {
      await mailer.sendEmail({
        to: user.email,
        template: "security-notice",
        data: {
          name: user.name || undefined,
          event: "password-reset",
          occurredAt: at,
        },
      });
    } catch (error) {
      console.error("password_reset_notice_failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  };
}
