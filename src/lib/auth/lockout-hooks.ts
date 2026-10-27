import "server-only";
import { BASE_ERROR_CODES } from "better-auth";
import { APIError, isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { auditRequestInfo } from "@/lib/audit";
import type { createAuthAuditHooks, HookContext } from "@/lib/auth/audit-hooks";
import { errorBody } from "@/lib/auth/audit-hooks";
import {
  findDevice,
  readDeviceCookie,
  rememberDevice,
  writeDeviceCookie,
  type DeviceCookie,
} from "@/lib/auth/known-device";
import {
  checkSignIn,
  clearAccountLock,
  recordFailedSignIn,
  recordSuccessfulSignIn,
} from "@/lib/auth/lockout";
import { normalizeEmail } from "@/lib/auth/policy";
import { UNLOCK_TOKEN_TTL_MS, issueUnlockToken } from "@/lib/auth/unlock-token";
import type { Mailer } from "@/lib/email/mailer";
import { tokenLinkUrl } from "@/lib/token-links/actions";

// Better Auth adapters for the lockout (docs/LOCKOUT.md). The hooks stay thin:
// the policy is lockout-policy.ts and the row work is lockout.ts.

type Logger = HookContext["context"]["logger"];

/**
 * Runs a task after the response. The call site always awaits it, so the
 * inline default is deterministic in tests; production passes Next's `after`.
 */
export type Defer = (task: () => Promise<void>) => void | Promise<void>;

const passwordBody = z.looseObject({ password: z.string() });
const emailBody = z.looseObject({ email: z.string() });

interface CookieContext {
  context: { secret: string };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
}

interface SignInContext extends HookContext, CookieContext {
  context: HookContext["context"] &
    CookieContext["context"] & {
      password: { hash(password: string): Promise<string> };
    };
}

interface SessionContext extends CookieContext {
  context: CookieContext["context"] & { logger: Logger };
  setSignedCookie(
    name: string,
    value: string,
    secret: string,
    attributes: {
      httpOnly: boolean;
      secure: boolean;
      sameSite: "lax";
      path: string;
      maxAge: number;
    },
  ): Promise<unknown>;
}

interface LockoutHooksInput {
  prisma: PrismaClient;
  mailer: Mailer;
  deviceCookie: DeviceCookie;
  /** Origin of every emailed link; the mailer rejects any other. */
  linkOrigin: string;
  defer?: Defer;
  auditHooks: ReturnType<typeof createAuthAuditHooks>;
}

export function createLockoutHooks({
  prisma,
  mailer,
  deviceCookie,
  linkOrigin,
  defer = (task) => task(),
  auditHooks,
}: LockoutHooksInput) {
  // A deferred task has no caller to throw to. It logs the step and the error
  // class only: the message could carry an address or a token.
  async function guarded(
    logger: Logger,
    step: string,
    task: () => Promise<void>,
  ) {
    try {
      await task();
    } catch (error) {
      logger.error("lockout_task_failed", {
        step,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  /**
   * `hooks.before`, for `/sign-in/email`. Refuses a locked attempt with the
   * error a wrong password gets, after the one password hash Better Auth would
   * have spent on an unknown user, so a refusal costs the same as any failure.
   */
  async function beforeSignIn(ctx: SignInContext, email: string) {
    const body = passwordBody.safeParse(ctx.body);
    // Left to Better Auth's own validation.
    if (!body.success) return;

    const deviceRaw = await readDeviceCookie(ctx, deviceCookie);
    const check = await checkSignIn(prisma, {
      email,
      deviceRaw,
      now: new Date(),
    });
    if (check.outcome === "proceed") return;

    await ctx.context.password.hash(body.data.password);
    const logger = ctx.context.logger;
    await defer(() =>
      guarded(logger, "refused_audit", () =>
        auditHooks.signInRefused(ctx, check.userId),
      ),
    );
    throw APIError.from(
      "UNAUTHORIZED",
      BASE_ERROR_CODES.INVALID_EMAIL_OR_PASSWORD,
    );
  }

  /**
   * `hooks.after`, for `/sign-in/email`. Counts a wrong password. Everything
   * past the cookie read is deferred, so a known and an unknown address take
   * the same synchronous path.
   */
  async function afterSignIn(ctx: SignInContext) {
    const returned = ctx.context.returned;
    if (!isAPIError(returned)) return;
    const code = errorBody.safeParse(returned.body);
    if (!code.success || code.data.code !== "INVALID_EMAIL_OR_PASSWORD") return;
    const body = emailBody.safeParse(ctx.body);
    if (!body.success) return;

    const email = normalizeEmail(body.data.email);
    const deviceRaw = await readDeviceCookie(ctx, deviceCookie);
    const headers = ctx.headers ?? ctx.request?.headers;
    const ip = headers ? auditRequestInfo(headers).ip : null;
    const logger = ctx.context.logger;

    await defer(() =>
      guarded(logger, "count_failure", () =>
        countFailure({ email, deviceRaw, ip, logger }),
      ),
    );
  }

  async function countFailure({
    email,
    deviceRaw,
    ip,
    logger,
  }: {
    email: string;
    deviceRaw: string | null;
    ip: string | null;
    logger: Logger;
  }) {
    const now = new Date();
    const check = await checkSignIn(prisma, { email, deviceRaw, now });
    // Unknown address, or a lock already in force: nothing to count.
    if (check.outcome === "refuse" || check.userId === null) return;
    const { userId, deviceId } = check;

    const issued: { token: string | null } = { token: null };
    const { locked } = await recordFailedSignIn(prisma, {
      userId,
      deviceId,
      ip,
      now,
      onLocked: async (tx, lock) => {
        issued.token = await issueUnlockToken(tx, userId, now);
        await auditHooks.accountLocked(tx, userId, {
          level: lock.level,
          durationMinutes: Math.round(lock.durationMs / 60_000),
          ip,
        });
      },
    });
    const token = issued.token;
    if (!locked || token === null) return;

    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { email: true, name: true, preferredName: true },
    });
    if (!user) return;
    const name = user.preferredName ?? user.name;

    // The lock stands whether or not either email goes out. A SendResult that
    // is not `sent` has already been logged by the mailer.
    await guarded(logger, "send_locked_email", async () => {
      await mailer.sendEmail({
        to: user.email,
        template: "account-locked",
        data: { name, lockedUntil: locked.until },
      });
    });
    await guarded(logger, "send_unlock_email", async () => {
      await mailer.sendEmail({
        to: user.email,
        template: "account-unlock",
        data: {
          name,
          url: tokenLinkUrl(linkOrigin, "account-unlock", token),
          expiresInMinutes: UNLOCK_TOKEN_TTL_MS / 60_000,
        },
      });
    });
  }

  /**
   * `databaseHooks.session.create.after`, for a session that is a login on any
   * path. Resets the counters and gives the browser its known-device cookie. A
   * failure here is logged and never fails the login.
   */
  async function sessionCreated(
    session: { userId: string; userAgent?: string | null },
    ctx: SessionContext | null,
  ) {
    try {
      const now = new Date();
      const raw = ctx ? await readDeviceCookie(ctx, deviceCookie) : null;
      const held = raw ? await findDevice(prisma, raw) : null;
      const deviceId = held?.userId === session.userId ? held.id : null;
      await recordSuccessfulSignIn(prisma, {
        userId: session.userId,
        deviceId,
        now,
      });
      if (!ctx) return;
      const device = await rememberDevice(prisma, {
        userId: session.userId,
        raw: deviceId ? raw : null,
        userAgent: session.userAgent ?? null,
        now,
      });
      await writeDeviceCookie(ctx, deviceCookie, device);
    } catch (error) {
      ctx?.context.logger.error("lockout_task_failed", {
        step: "session_created",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  /**
   * `emailAndPassword.onPasswordReset`. A reset proves control of the mailbox,
   * so it lifts the lock. Never fails the reset itself.
   */
  async function passwordReset(
    { user }: { user: { id: string } },
    request?: Request,
  ) {
    try {
      const now = new Date();
      await prisma.$transaction(async (tx) => {
        const { wasLocked } = await clearAccountLock(tx, {
          userId: user.id,
          now,
        });
        if (wasLocked) {
          await auditHooks.accountUnlocked(
            tx,
            user.id,
            "password_reset",
            request,
          );
        }
      });
    } catch (error) {
      console.error("lockout_task_failed", {
        step: "password_reset",
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  return {
    beforeSignIn,
    afterSignIn,
    sessionCreated,
    passwordReset,
  };
}
