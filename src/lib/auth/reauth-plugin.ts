import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import {
  APIError,
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from "better-auth/api";
import type { PrismaClient } from "@/generated/prisma/client";
import { auditRequestInfo, withAuditTransaction } from "@/lib/audit";
import { createAuthAuditHooks } from "@/lib/auth/audit-hooks";
import { deviceCookieName, resolveCookiePolicy } from "@/lib/auth/cookies";
import { hasFreshAuth } from "@/lib/auth/fresh-auth";
import { readDeviceCookie } from "@/lib/auth/known-device";
import { checkSignIn, recordSuccessfulSignIn } from "@/lib/auth/lockout";
import { createLockoutHooks } from "@/lib/auth/lockout-hooks";
import {
  FRESH_AUTH_AUTH_PATHS,
  REAUTH_ERROR_CODES,
  REAUTH_WINDOW_MS,
  reauthBodySchema,
} from "@/lib/auth/reauth-policy";
import { verifySecondFactor } from "@/lib/auth/second-factor";
import type { Mailer } from "@/lib/email/mailer";
import type { SgauthEnv } from "@/lib/env-schema";

interface SgauthReauthInput {
  prisma: PrismaClient;
  sgauthEnv: SgauthEnv;
  /** Sends the lock notice and unlock link when a failure takes the lock. */
  mailer: Mailer;
  /** Origin of every emailed link. */
  linkOrigin: string;
  /** The auth secret; keys the backup-code hashes. */
  secret: string;
}

// Thrown inside the stamp's transaction so it rolls back.
class SecondFactorReplayed extends Error {}
class SessionGone extends Error {}

const unauthorized = () =>
  APIError.from("UNAUTHORIZED", {
    code: "UNAUTHORIZED",
    message: "Sign in to continue.",
  });

/**
 * Re-authentication for sensitive actions (docs/REAUTH.md): the credential
 * check that stamps `Session.lastReauthAt`, and the gate on the Better Auth
 * endpoints that are sensitive.
 *
 * The endpoint is `SERVER_ONLY`, so Better Auth's router never serves it at
 * `/api/auth/*`. `src/app/api/sgauth/reauth/route.ts` is its only way in.
 */
export function sgauthReauth({
  prisma,
  sgauthEnv,
  mailer,
  linkOrigin,
  secret,
}: SgauthReauthInput) {
  const cookiePolicy = resolveCookiePolicy(sgauthEnv);
  const deviceCookie = {
    name: deviceCookieName(cookiePolicy),
    secure: cookiePolicy.secure,
  };
  const auditHooks = createAuthAuditHooks(prisma);
  const lockoutHooks = createLockoutHooks({
    prisma,
    mailer,
    deviceCookie,
    linkOrigin,
    auditHooks,
  });

  const sgauthReauthenticate = createAuthEndpoint(
    "/sgauth/reauth",
    {
      method: "POST",
      body: reauthBodySchema,
      metadata: { SERVER_ONLY: true },
      use: [sessionMiddleware],
    },
    async (ctx) => {
      const { password, code } = ctx.body;
      const { session, user: sessionUser } = ctx.context.session;
      const userId = sessionUser.id;
      const now = new Date();
      const headers = ctx.headers ?? ctx.request?.headers;
      const logger = ctx.context.logger;

      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: { email: true, twoFactorEnabled: true },
      });
      if (!user) throw unauthorized();
      const enrolled = user.twoFactorEnabled === true;

      // Before anything is verified or counted, so leaving the code out never
      // becomes a password oracle.
      if (enrolled && !code) {
        throw APIError.from(
          "BAD_REQUEST",
          REAUTH_ERROR_CODES.TWO_FACTOR_CODE_REQUIRED,
        );
      }

      const deviceRaw = await readDeviceCookie(ctx, deviceCookie);
      const check = await checkSignIn(prisma, {
        email: user.email,
        deviceRaw,
        now,
      });
      // A refused attempt is not counted again, as at sign-in.
      if (check.outcome === "refuse") {
        await auditHooks.reauthFailed(ctx, userId, "ACCOUNT_LOCKED");
        throw APIError.from("FORBIDDEN", REAUTH_ERROR_CODES.REAUTH_LOCKED);
      }
      const { deviceId } = check;

      let passwordOk = false;
      const account =
        await ctx.context.internalAdapter.findCredentialAccount(userId);
      if (account?.password) {
        passwordOk = await ctx.context.password.verify({
          hash: account.password,
          password,
        });
      } else {
        // A password-less account still pays for one hash.
        await ctx.context.password.hash(password);
      }

      // Checked even when the password is already wrong, so both failures cost
      // the same and the answer never says which factor was wrong.
      const secondResult =
        enrolled && code
          ? await verifySecondFactor(prisma, {
              userId,
              code,
              secretConfig: ctx.context.secretConfig,
              secret,
              now,
              logger,
            })
          : null;
      const second = secondResult?.ok ? secondResult : null;

      async function fail(): Promise<never> {
        await lockoutHooks.recordFailure({
          userId,
          deviceId,
          ip: headers ? auditRequestInfo(headers).ip : null,
          now,
          logger,
        });
        await auditHooks.reauthFailed(ctx, userId, "INVALID_CREDENTIALS");
        throw APIError.from(
          "BAD_REQUEST",
          REAUTH_ERROR_CODES.INVALID_REAUTH_CREDENTIALS,
        );
      }

      if (!passwordOk || (enrolled && !second)) return fail();

      try {
        await withAuditTransaction(prisma, async (tx) => {
          if (second && !(await second.commit(tx))) {
            throw new SecondFactorReplayed();
          }
          const stamped = await tx.session.updateMany({
            where: { id: session.id },
            data: { lastReauthAt: now },
          });
          if (stamped.count === 0) throw new SessionGone();
          await recordSuccessfulSignIn(tx, {
            userId,
            deviceId,
            now,
          });
          await auditHooks.reauthSucceeded(
            tx,
            userId,
            second
              ? second.method === "totp"
                ? "password_totp"
                : "password_backup_code"
              : "password",
            headers,
          );
          if (second?.method === "backup_code") {
            await auditHooks.reauthBackupCodeUsed(tx, userId, headers);
          }
        });
      } catch (error) {
        if (error instanceof SecondFactorReplayed) return fail();
        if (error instanceof SessionGone) throw unauthorized();
        throw error;
      }

      return ctx.json({
        status: true,
        freshUntil: new Date(now.getTime() + REAUTH_WINDOW_MS).toISOString(),
      });
    },
  );

  return {
    id: "sgauth-reauth",
    endpoints: { sgauthReauthenticate },
    hooks: {
      before: [
        {
          matcher: (ctx) => FRESH_AUTH_AUTH_PATHS.includes(ctx.path ?? ""),
          handler: createAuthMiddleware(async (ctx) => {
            // No session: the endpoint answers 401 itself. A server-side
            // `auth.api` call with no headers has none, so it is unaffected.
            const session = await getSessionFromCtx(ctx);
            if (!session) return;
            if (!(await hasFreshAuth(prisma, session.session.id))) {
              throw APIError.from(
                "FORBIDDEN",
                REAUTH_ERROR_CODES.REAUTH_REQUIRED,
              );
            }
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
