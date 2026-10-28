import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthMiddleware,
  getSessionFromCtx,
} from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { TWO_FACTOR_ERROR_CODES } from "better-auth/plugins";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { hashBackupCode } from "@/lib/auth/backup-codes";
import { MFA_ERROR_CODES, canDisableMfa } from "@/lib/auth/mfa-policy";
import { claimTotpStep } from "@/lib/auth/second-factor";
import { resolveChallengeUserId } from "@/lib/auth/two-factor-challenge";
import { matchTotpStep } from "@/lib/auth/totp";

interface SgauthMfaInput {
  prisma: PrismaClient;
  /** The auth secret; keys the backup-code hashes. */
  secret: string;
}

// Lenient on purpose: a body that does not parse is left to the endpoint's own
// validation, which rejects it.
const codeBody = z.looseObject({ code: z.string() });

/**
 * Closes the gaps between Better Auth's twoFactor plugin and the MFA contract:
 * no TOTP replay protection, reversibly stored backup codes, a client-chosen
 * `trustDevice`, and a disable endpoint with no role check.
 *
 * A before hook's returned body is merged into the request body, not swapped
 * for it, so a flag is switched off by returning it as `false`, never by
 * leaving it out.
 */
export function sgauthMfa({
  prisma,
  secret,
}: SgauthMfaInput): BetterAuthPlugin {
  return {
    id: "sgauth-mfa",
    hooks: {
      before: [
        {
          matcher: (ctx) => ctx.path === "/two-factor/verify-totp",
          handler: createAuthMiddleware(async (ctx) => {
            const body = codeBody.safeParse(ctx.body);
            if (!body.success) return;
            const { code } = body.data;
            const noTrust = { context: { body: { code, trustDevice: false } } };

            const session = await getSessionFromCtx(ctx);
            const userId =
              session?.user.id ?? (await resolveChallengeUserId(ctx));
            if (!userId) return noTrust;
            const row = await prisma.twoFactor.findFirst({
              where: { userId },
              select: { id: true, secret: true, lockedUntil: true },
            });
            if (!row) return noTrust;
            // A locked account is rejected by the plugin whatever the code, so
            // a claim here would only burn a valid code for its ~90s window.
            if (row.lockedUntil && row.lockedUntil.getTime() > Date.now()) {
              return noTrust;
            }

            const totpSecret = await symmetricDecrypt({
              key: ctx.context.secretConfig,
              data: row.secret,
            });
            const step = matchTotpStep(totpSecret, code, Date.now());
            // A wrong code goes to the plugin, which rejects it and counts the
            // failure.
            if (step === null) return noTrust;

            // The same error as a wrong guess, so a replay is indistinguishable.
            if (!(await claimTotpStep(prisma, row.id, step))) {
              throw APIError.from(
                "UNAUTHORIZED",
                TWO_FACTOR_ERROR_CODES.INVALID_CODE,
              );
            }
            return noTrust;
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/verify-backup-code",
          handler: createAuthMiddleware(async (ctx) => {
            const body = codeBody.safeParse(ctx.body);
            if (!body.success) return;
            // The plugin looks the code up with `includes()` in the stored
            // list, which holds hashes, so it must be given the hash.
            return {
              context: {
                body: {
                  code: hashBackupCode(secret, body.data.code),
                  trustDevice: false,
                  disableSession: false,
                },
              },
            };
          }),
        },
        {
          matcher: (ctx) => ctx.path === "/two-factor/disable",
          handler: createAuthMiddleware(async (ctx) => {
            // No session: the endpoint answers 401 itself.
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            const user = await prisma.user.findUnique({
              where: { id: session.user.id },
              select: {
                isAdmin: true,
                isPrimaryAdmin: true,
                twoFactorEnabled: true,
                status: true,
              },
            });
            if (user && !canDisableMfa(user)) {
              throw APIError.from(
                "FORBIDDEN",
                MFA_ERROR_CODES.MFA_REQUIRED_FOR_ADMIN,
              );
            }
          }),
        },
      ],
    },
  };
}
