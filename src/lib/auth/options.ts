import "server-only";
import type { BetterAuthOptions } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { deleteSessionCookie } from "better-auth/cookies";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  AUTH_ERROR_CODES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isAllowedSignupEmail,
  normalizeEmail,
} from "@/lib/auth/policy";
import {
  SESSION_OPTIONS,
  initialSessionWindow,
} from "@/lib/auth/session-lifetime";
import { createAuthAuditHooks } from "@/lib/auth/audit-hooks";
import {
  rehashLegacyPassword,
  verifyPassword,
} from "@/lib/auth/legacy-password";
import { setRequestUserId } from "@/lib/log/context";

/**
 * Endpoint paths allowed to create a user outside the sign-up domain rule.
 * Empty until the admin user-creation endpoint lands. Creation with no
 * endpoint context at all (trusted server code, such as import scripts) is
 * always allowed.
 */
export const ADMIN_USER_CREATION_PATHS: readonly string[] = [];

interface AuthOptionsInput {
  prisma: PrismaClient;
  baseURL: string;
  secret: string;
  /** Versioned secrets, current first; see `BETTER_AUTH_SECRETS`. */
  secrets?: { version: number; value: string }[];
  trustedOrigins?: BetterAuthOptions["trustedOrigins"];
  /** Cookie attributes from `buildCookieOptions`; config.ts supplies them. */
  advanced?: BetterAuthOptions["advanced"];
}

// Lenient on purpose: anything that does not parse is left to the endpoint's
// own validation.
const credentialsBody = z.looseObject({ email: z.string() });
const passwordBody = z.looseObject({ password: z.string() });

const sessionResult = z.looseObject({
  user: z.looseObject({ id: z.string(), status: z.string() }),
});

// Never 403: the sign-up endpoint turns a 403 from user creation into its
// generic duplicate-account success.
function domainNotAllowed() {
  return APIError.from(
    "BAD_REQUEST",
    AUTH_ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED,
  );
}

export function buildAuthOptions({
  prisma,
  baseURL,
  secret,
  secrets,
  trustedOrigins,
  advanced,
}: AuthOptionsInput) {
  const auditHooks = createAuthAuditHooks(prisma);

  // Runs only after a successful sign-in, so a wrong, unverified or
  // deactivated sign-in never re-hashes. The sign-in has already succeeded:
  // a failure here is logged without the error and the account stays bcrypt
  // until the next login retries.
  async function rehashAfterSignIn(ctx: {
    body?: unknown;
    headers?: Headers;
    request?: Request;
    context: {
      logger: { error: (message: string, ...args: unknown[]) => void };
      newSession?: { user: { id: string } } | null;
      returned?: unknown;
      password: { hash: (password: string) => Promise<string> };
    };
  }) {
    if (isAPIError(ctx.context.returned)) return;
    const userId = ctx.context.newSession?.user.id;
    const body = passwordBody.safeParse(ctx.body);
    if (!userId || !body.success) return;
    try {
      const rehashed = await rehashLegacyPassword(prisma, {
        userId,
        password: body.data.password,
        hash: ctx.context.password.hash,
      });
      if (rehashed) await auditHooks.passwordRehashed(ctx, userId);
    } catch {
      ctx.context.logger.error("Failed to re-hash legacy password", {
        userId,
      });
    }
  }

  return {
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    baseURL,
    secret,
    ...(secrets ? { secrets } : {}),
    trustedOrigins,
    // Disabled so a GET never consumes the token; the /verify-email page and
    // its POST call `auth.api.verifyEmail` in-process instead.
    disabledPaths: ["/verify-email"],
    session: SESSION_OPTIONS,
    advanced: {
      ...advanced,
      database: { generateId: false },
      // Vercel overwrites x-forwarded-for with the client IP, so it is a single
      // value. Better Auth trusts only a single value and stores "" for a
      // chain, whose leftmost hop is spoofable. This is its default, written
      // out to record the decision. The rate limiter keys on the same header.
      ipAddress: { ipAddressHeaders: ["x-forwarded-for"] },
    },
    emailAndPassword: {
      enabled: true,
      minPasswordLength: PASSWORD_MIN_LENGTH,
      maxPasswordLength: PASSWORD_MAX_LENGTH,
      requireEmailVerification: true,
      autoSignIn: false,
      onPasswordReset: auditHooks.passwordReset,
      // `hash` stays unset so new hashes use Better Auth's default scrypt.
      password: { verify: verifyPassword },
    },
    // Puts `status` on session.user. Clients can never set it.
    user: {
      additionalFields: {
        status: { type: "string", input: false, required: false },
      },
    },
    emailVerification: {
      // Fires only on the plain verify path, before Better Auth creates its
      // auto-sign-in session, so it never revokes that session.
      beforeEmailVerification: async (user) => {
        await prisma.session.deleteMany({ where: { userId: user.id } });
      },
      afterEmailVerification: auditHooks.emailVerified,
    },
    hooks: {
      before: createAuthMiddleware(async (ctx) => {
        const parsed = credentialsBody.safeParse(ctx.body);
        if (!parsed.success) return;
        const normalized = normalizeEmail(parsed.data.email);

        if (
          ctx.path === "/sign-up/email" &&
          !isAllowedSignupEmail(normalized)
        ) {
          throw domainNotAllowed();
        }

        return {
          context: { body: { ...parsed.data, email: normalized } },
        };
      }),
      after: createAuthMiddleware(async (ctx) => {
        await auditHooks.afterEndpoint(ctx);
        if (
          ctx.path === "/revoke-sessions" &&
          !isAPIError(ctx.context.returned)
        ) {
          // revoke-sessions deletes the current row too; expire its cookie.
          deleteSessionCookie(ctx);
        }
        if (ctx.path === "/sign-in/email") await rehashAfterSignIn(ctx);
        if (ctx.path !== "/get-session") return;
        const parsed = sessionResult.safeParse(ctx.context.returned);
        if (!parsed.success || parsed.data.user.status === "ACTIVE") return;
        await prisma.session.deleteMany({
          where: { userId: parsed.data.user.id },
        });
        throw APIError.from(
          "UNAUTHORIZED",
          AUTH_ERROR_CODES.ACCOUNT_DEACTIVATED,
        );
      }),
    },
    databaseHooks: {
      user: {
        create: {
          // Backstop for any creation path.
          before: async (user, ctx) => {
            if (
              ctx?.path &&
              !ADMIN_USER_CREATION_PATHS.includes(ctx.path) &&
              !isAllowedSignupEmail(user.email)
            ) {
              throw domainNotAllowed();
            }
            return { data: { ...user, email: normalizeEmail(user.email) } };
          },
          after: auditHooks.userCreated,
        },
        update: {
          after: auditHooks.userUpdated,
        },
      },
      session: {
        create: {
          // Throws rather than returning false, which Better Auth turns into a
          // generic FAILED_TO_CREATE_SESSION.
          before: async (session) => {
            const user = await prisma.user.findUnique({
              where: { id: session.userId },
              select: { status: true },
            });
            if (user && user.status !== "ACTIVE") {
              throw APIError.from(
                "FORBIDDEN",
                AUTH_ERROR_CODES.ACCOUNT_DEACTIVATED,
              );
            }
            return {
              data: {
                ...session,
                ...initialSessionWindow({
                  createdAt: session.createdAt,
                  expiresAt: session.expiresAt,
                }),
              },
            };
          },
          // Covers every login path, including auto sign-in after verification.
          after: async (session, ctx) => {
            // Request log lines for sign-in and sign-up carry the user id.
            setRequestUserId(session.userId);
            // A rotation, or the interim session of a sign-in that still owes
            // its second factor, is not a login.
            if (!(await auditHooks.isLoginSession(session, ctx))) return;
            try {
              await prisma.user.update({
                where: { id: session.userId },
                data: { lastLoginAt: new Date() },
              });
            } catch (error) {
              ctx?.context.logger.error("Failed to record lastLoginAt", error);
            }
            await auditHooks.sessionCreated(session, ctx);
          },
        },
        delete: {
          after: auditHooks.sessionDeleted,
        },
      },
    },
  } satisfies BetterAuthOptions;
}
