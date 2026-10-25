import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { Analytics } from "@/lib/analytics/analytics";
import { ANALYTICS_EVENTS } from "@/lib/analytics/events";
import {
  LOGIN_METHODS,
  type HookContext,
  type HookSession,
  type HookUser,
} from "@/lib/auth/audit-hooks";

const errorBody = z.looseObject({ code: z.string() });
const loginFailedReason = ANALYTICS_EVENTS.login_failed.shape.reason;

/**
 * Adapters from Better Auth hooks to analytics events, wired beside the audit
 * hooks. Each one only schedules a send, so it adds no latency, and a failure
 * is swallowed: analytics can never fail an auth request. Failed logins and
 * reset requests stay anonymous, because there is no user lookup by email.
 */
export function createAuthAnalyticsHooks(
  analytics: Pick<Analytics, "capture">,
) {
  function afterSignInEmail(ctx: HookContext) {
    const returned = ctx.context.returned;
    if (!isAPIError(returned)) return;
    const code = errorBody.safeParse(returned.body);
    const reason = loginFailedReason.safeParse(
      code.success ? code.data.code : undefined,
    );
    analytics.capture("login_failed", {
      properties: { reason: reason.success ? reason.data : "OTHER" },
    });
  }

  return {
    /** `hooks.after`: every endpoint, success or failure. */
    afterEndpoint(ctx: HookContext): void {
      try {
        switch (ctx.path) {
          case "/sign-in/email":
            return afterSignInEmail(ctx);
          case "/request-password-reset":
            // Better Auth returns the same success for an unknown account, so
            // this counts requests without revealing anything.
            if (isAPIError(ctx.context.returned)) return;
            return analytics.capture("reset_requested", { properties: {} });
        }
      } catch {
        // Nothing to report: the failure is in analytics, not in the request.
      }
    },

    /** `databaseHooks.session.create.after`: every login path. */
    sessionCreated(session: HookSession, ctx: HookContext | null): void {
      try {
        analytics.capture("login_succeeded", {
          userId: session.userId,
          properties: { method: LOGIN_METHODS[ctx?.path ?? ""] ?? "other" },
        });
      } catch {
        // See afterEndpoint.
      }
    },

    /** `databaseHooks.user.create.after`: self sign-up only. */
    userCreated(user: HookUser, ctx: HookContext | null): void {
      try {
        if (ctx?.path !== "/sign-up/email") return;
        analytics.capture("signup_started", {
          userId: user.id,
          properties: {},
        });
      } catch {
        // See afterEndpoint.
      }
    },

    /** `emailVerification.afterEmailVerification`. */
    emailVerified(user: HookUser): void {
      try {
        analytics.capture("signup_completed", {
          userId: user.id,
          properties: {},
        });
      } catch {
        // See afterEndpoint.
      }
    },

    /** `emailAndPassword.onPasswordReset`. */
    passwordReset({ user }: { user: HookUser }): void {
      try {
        analytics.capture("reset_completed", {
          userId: user.id,
          properties: {},
        });
      } catch {
        // See afterEndpoint.
      }
    },
  };
}
