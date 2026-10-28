import "server-only";
import { APIError, isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { auditRequestInfo, withAuditTransaction } from "@/lib/audit";
import type { createAuthAuditHooks, HookContext } from "@/lib/auth/audit-hooks";
import { errorBody } from "@/lib/auth/audit-hooks";
import {
  findDevice,
  readDeviceCookie,
  type DeviceCookie,
} from "@/lib/auth/known-device";
import { checkSignIn, recordSuccessfulSignIn } from "@/lib/auth/lockout";
import type { createLockoutHooks } from "@/lib/auth/lockout-hooks";
import { AUTH_ERROR_CODES } from "@/lib/auth/policy";
import type { Mailer } from "@/lib/email/mailer";
import {
  TOO_MANY_REQUESTS_BODY,
  tooManyRequestsHeaders,
  type RateLimiter,
} from "@/lib/rate-limit/limiter";

// SGAuth's side of Better Auth's `POST /change-password` (docs/LOCKOUT.md,
// docs/RATE-LIMITING.md). Better Auth checks the session, the length and the
// current password and writes the hash; these hooks add the rate limit, the
// lockout, the revocation of every other session and the notice. The fresh
// re-auth gate is the sgauth-reauth plugin's, not repeated here.

export const CHANGE_PASSWORD_PATH = "/change-password";

const bodyShape = z.looseObject({
  currentPassword: z.string(),
  newPassword: z.string(),
});

interface CookieContext {
  context: { secret: string };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
}

export interface PasswordChangeContext extends HookContext, CookieContext {
  context: HookContext["context"] & CookieContext["context"];
}

/** The part of Better Auth's session the hooks read. */
export interface PasswordChangeSession {
  session: { id: string };
  user: { id: string; email: string };
}

interface PasswordChangeHooksInput {
  prisma: PrismaClient;
  mailer: Pick<Mailer, "sendEmail">;
  deviceCookie: DeviceCookie;
  auditHooks: ReturnType<typeof createAuthAuditHooks>;
  /** Counts a wrong password and runs the lock side effects. */
  lockoutHooks: Pick<ReturnType<typeof createLockoutHooks>, "recordFailure">;
  rateLimiter: Pick<RateLimiter, "check">;
  now?: () => Date;
}

export function createPasswordChangeHooks({
  prisma,
  mailer,
  deviceCookie,
  auditHooks,
  lockoutHooks,
  rateLimiter,
  now = () => new Date(),
}: PasswordChangeHooksInput) {
  // The device id only when the cookie names a row of this user, the rule
  // `checkSignIn` applies at sign-in.
  async function resolveDevice(
    ctx: PasswordChangeContext,
    userId: string,
  ): Promise<string | null> {
    const raw = await readDeviceCookie(ctx, deviceCookie);
    const device = raw ? await findDevice(prisma, raw) : null;
    return device?.userId === userId ? device.id : null;
  }

  /**
   * `hooks.before`. `session` is the caller's session lookup; with none the
   * endpoint answers 401 itself, so an anonymous request costs no Redis call.
   * A throw here skips Better Auth's `after` hooks.
   */
  async function before(
    ctx: PasswordChangeContext,
    session: PasswordChangeSession | null,
  ) {
    if (!session) return;
    const userId = session.user.id;

    // HTTP traffic only: trusted server-side `auth.api` calls stay unlimited,
    // as for every policy. Checked before the body is parsed, so malformed and
    // same-password requests count too.
    if (ctx.request) {
      const result = await rateLimiter.check("changePassword", {
        user: userId,
      });
      if (!result.allowed) {
        throw new APIError(
          "TOO_MANY_REQUESTS",
          TOO_MANY_REQUESTS_BODY,
          tooManyRequestsHeaders(result.retryAfterSeconds),
        );
      }
    }

    // Left to Better Auth's own validation when it does not parse.
    const body = bodyShape.safeParse(ctx.body);
    if (!body.success) return;

    // Before any verification, so it costs no hash and counts nowhere.
    if (body.data.currentPassword === body.data.newPassword) {
      throw APIError.from(
        "BAD_REQUEST",
        AUTH_ERROR_CODES.NEW_PASSWORD_SAME_AS_CURRENT,
      );
    }

    const check = await checkSignIn(prisma, {
      email: session.user.email,
      deviceRaw: await readDeviceCookie(ctx, deviceCookie),
      now: now(),
    });
    // A refused attempt is not counted again, as at sign-in.
    if (check.outcome === "refuse") {
      await auditHooks.passwordChangeFailed(ctx, userId, "ACCOUNT_LOCKED");
      throw APIError.from("FORBIDDEN", AUTH_ERROR_CODES.PASSWORD_CHANGE_LOCKED);
    }

    // The client's `revokeOtherSessions` is overridden: Better Auth would
    // delete the current session too and mint a new 90-day one. `after`
    // revokes the others itself.
    return {
      context: { body: { ...body.data, revokeOtherSessions: false } },
    };
  }

  /**
   * `hooks.after`. `session` is the caller's session, from the endpoint
   * context or a fresh lookup. A failure in the success transaction rejects,
   * so a half-done change surfaces as a 500 rather than a silent success.
   */
  async function after(
    ctx: PasswordChangeContext,
    session: PasswordChangeSession | null,
  ) {
    if (!session) return;
    const userId = session.user.id;
    const returned = ctx.context.returned;

    if (isAPIError(returned)) {
      const code = errorBody.safeParse(returned.body);
      // PASSWORD_TOO_SHORT, PASSWORD_TOO_LONG and CREDENTIAL_ACCOUNT_NOT_FOUND
      // count nowhere.
      if (!code.success || code.data.code !== "INVALID_PASSWORD") return;

      const headers = ctx.headers ?? ctx.request?.headers;
      await lockoutHooks.recordFailure({
        userId,
        deviceId: await resolveDevice(ctx, userId),
        ip: headers ? auditRequestInfo(headers).ip : null,
        now: now(),
        logger: ctx.context.logger,
      });
      await auditHooks.passwordChangeFailed(
        ctx,
        userId,
        "INVALID_CURRENT_PASSWORD",
      );
      return;
    }

    const at = now();
    const deviceId = await resolveDevice(ctx, userId);
    const headers = ctx.headers ?? ctx.request?.headers;
    const user = await withAuditTransaction(prisma, async (tx) => {
      await tx.session.deleteMany({
        where: { userId, id: { not: session.session.id } },
      });
      const updated = await tx.user.update({
        where: { id: userId },
        data: { passwordChangedAt: at },
        select: { email: true, name: true, preferredName: true },
      });
      // A correct current password is as good as a sign-in.
      await recordSuccessfulSignIn(tx, { userId, deviceId, now: at });
      await auditHooks.passwordChanged(
        tx,
        userId,
        { revokedOtherSessions: true },
        headers,
      );
      return updated;
    });

    // After the commit, and never failing it. The logger gets no error object:
    // it could carry the address.
    const notice = (async () => {
      try {
        await mailer.sendEmail({
          to: user.email,
          template: "security-notice",
          data: {
            name: user.preferredName ?? user.name,
            event: "password-changed",
            occurredAt: at,
          },
        });
      } catch {
        ctx.context.logger.error("Failed to send password-changed notice");
      }
    })();
    await (ctx.context.runInBackgroundOrAwait
      ? ctx.context.runInBackgroundOrAwait(notice)
      : notice);
  }

  return { before, after };
}
