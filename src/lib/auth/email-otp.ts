import "server-only";
import type { BetterAuthPlugin } from "better-auth";
import { APIError, createAuthMiddleware, isAPIError } from "better-auth/api";
import { emailOTP } from "better-auth/plugins";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { createAuthAuditHooks } from "@/lib/auth/audit-hooks";
import {
  dailyCapReached,
  otpEligibility,
  type OtpRefusal,
} from "@/lib/auth/email-otp-policy";
import { readDeviceCookie, type DeviceCookie } from "@/lib/auth/known-device";
import { checkSignIn } from "@/lib/auth/lockout";
import type { CapStore } from "@/lib/email/caps";
import { hashRecipient, type Mailer } from "@/lib/email/mailer";
import { clientIp } from "@/lib/client-ip";
import {
  TOO_MANY_REQUESTS_BODY,
  tooManyRequestsHeaders,
  type RateLimiter,
} from "@/lib/rate-limit/limiter";

// Sign-in by emailed code (docs/runbooks/email-otp.md). Registered only while
// SGAUTH_EMAIL_OTP_ENABLED is true, so with the flag off none of this exists.

const SEND_PATH = "/email-otp/send-verification-otp";
const SIGN_IN_PATH = "/sign-in/email-otp";

export const EMAIL_OTP_LIFETIME_SECONDS = 600;

/**
 * Every other route of the plugin. Each would let a code do something this
 * feature must not: verify an address, reset a password, change an address, or
 * test a code without consuming it. `createVerificationOTP` and
 * `getVerificationOTP` are server-only and have no HTTP path.
 */
export const EMAIL_OTP_DISABLED_PATHS: readonly string[] = [
  "/email-otp/verify-email",
  "/email-otp/check-verification-otp",
  "/email-otp/request-password-reset",
  "/forget-password/email-otp",
  "/email-otp/reset-password",
  "/email-otp/request-email-change",
  "/email-otp/change-email",
];

/** The global send counter's key, one per UTC day. The store adds the env prefix. */
export function sendCounterKey(now: Date): string {
  return `email-otp:sends:${now.toISOString().slice(0, 10)}`;
}

const COUNTER_TTL_SECONDS = 48 * 60 * 60;

// Lenient on purpose: other fields pass through to the endpoint, whose own
// validation rejects what it does not accept.
const sendBody = z.looseObject({
  email: z.string().trim().max(320).toLowerCase(),
  type: z.literal("sign-in"),
});
const signInBody = z.looseObject({
  email: z.string().trim().max(320).toLowerCase(),
  otp: z.string().max(64),
});

interface Logger {
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
}

export interface EmailOtpInput {
  prisma: PrismaClient;
  /** `dailyCap`: sends a day, across every address. */
  settings: { dailyCap: number };
  rateLimiter: Pick<RateLimiter, "check">;
  /** Holds the global daily counter. */
  capStore: CapStore;
  mailer: Pick<Mailer, "sendEmail">;
  deviceCookie: DeviceCookie;
  logger: Logger;
  now?: () => Date;
}

// The same error the plugin raises for a wrong code, so a refusal by the
// eligibility rules cannot be told from a wrong guess.
const INVALID_OTP = {
  code: "INVALID_OTP",
  message: "Invalid OTP",
} as const;

// The plugin's own answers that exist only for an address with an issued code.
const CONCEALED_CODES: ReadonlySet<string> = new Set([
  "TOO_MANY_ATTEMPTS",
  "OTP_EXPIRED",
]);

function invalidOtp() {
  return APIError.from("BAD_REQUEST", INVALID_OTP);
}

function invalidRequest() {
  return APIError.from("BAD_REQUEST", {
    code: "INVALID_REQUEST",
    message: "Invalid request",
  });
}

function rateLimited(retryAfterSeconds: number) {
  return new APIError(
    "TOO_MANY_REQUESTS",
    { ...TOO_MANY_REQUESTS_BODY, retryAfterSeconds },
    tooManyRequestsHeaders(retryAfterSeconds),
  );
}

// One body for every address and every cause, so it reveals nothing about
// which accounts exist.
function unavailable() {
  return APIError.from("SERVICE_UNAVAILABLE", {
    code: "EMAIL_OTP_UNAVAILABLE",
    message: "Email codes are unavailable right now",
  });
}

interface DeviceCookieContext {
  context: { secret: string };
  getSignedCookie(name: string, secret: string): Promise<string | null | false>;
}

function auditReason(refusal: OtpRefusal) {
  switch (refusal) {
    case "no_account":
      return "OTP_NO_ACCOUNT";
    case "inactive":
      return "OTP_INACTIVE";
    case "unverified":
      return "OTP_UNVERIFIED";
    case "admin":
      return "OTP_ADMIN";
    case "mfa":
      return "OTP_MFA";
    case "locked":
      return "OTP_LOCKED";
  }
}

export function createEmailOtp({
  prisma,
  settings,
  rateLimiter,
  capStore,
  mailer,
  deviceCookie,
  logger,
  now = () => new Date(),
}: EmailOtpInput) {
  const auditHooks = createAuthAuditHooks(prisma);

  async function loadUser(email: string) {
    return prisma.user.findUnique({
      where: { email },
      select: {
        id: true,
        status: true,
        emailVerified: true,
        isAdmin: true,
        isPrimaryAdmin: true,
        twoFactorEnabled: true,
      },
    });
  }

  /**
   * Whether this sign-in may proceed for `email` from this browser. A valid
   * known-device cookie for the account is exempt from the account lock,
   * exactly as at the password step (`checkSignIn`).
   */
  async function eligibility(email: string, deviceRaw: string | null) {
    const user = await loadUser(email);
    const lock = await checkSignIn(prisma, {
      email,
      deviceRaw,
      now: now(),
    });
    return {
      user,
      reason: otpEligibility(user, lock.outcome === "refuse"),
    };
  }

  /**
   * The before hook for `/email-otp/send-verification-otp`. It answers the
   * same for every address: eligibility is decided in the send callback.
   */
  async function guardSend(body: unknown, headers: Headers | undefined) {
    const parsed = sendBody.safeParse(body);
    if (!parsed.success) throw invalidRequest();
    const { email } = parsed.data;
    const ip = headers ? clientIp(headers) : "unknown";

    const limit = await rateLimiter.check("emailOtpSend", { ip, email });
    if (!limit.allowed) throw rateLimited(limit.retryAfterSeconds);

    // Counted before eligibility on purpose: refusing at the cap only for
    // eligible addresses would show which addresses are eligible, so every
    // request counts, and unknown addresses spend the cap too (the runbook
    // names this). The per-IP send limit above bounds how fast they can.
    //
    // Unlike every other limit, this one fails closed: a cap that fails open
    // is the volume overrun this feature exists to prevent, and password
    // sign-in still works through an Upstash outage.
    let count: number;
    try {
      [count] = await capStore.incr([
        { key: sendCounterKey(now()), ttlSeconds: COUNTER_TTL_SECONDS },
      ]);
    } catch (error) {
      logger.error("[ALERT] email-otp send counter unavailable", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
      throw unavailable();
    }
    if (count === Math.ceil(settings.dailyCap * 0.8)) {
      logger.error("[ALERT] email-otp daily cap 80%", {
        count,
        dailyCap: settings.dailyCap,
      });
    }
    if (dailyCapReached(count, settings.dailyCap)) {
      if (count === settings.dailyCap + 1) {
        logger.error("[ALERT] email-otp daily cap reached", {
          dailyCap: settings.dailyCap,
        });
      }
      throw unavailable();
    }

    return { ...parsed.data, email };
  }

  /**
   * The before hook for `/sign-in/email-otp`. A refusal by the eligibility
   * rules is the error a wrong code gets, and backs up the check at send time:
   * a code requested before an account became ineligible must not sign it in.
   */
  async function guardSignIn(
    ctx: DeviceCookieContext & Parameters<typeof auditHooks.emailOtpFailed>[0],
    body: unknown,
  ) {
    const parsed = signInBody.safeParse(body);
    if (!parsed.success) throw invalidRequest();
    const { email } = parsed.data;
    const headers = ctx.headers ?? ctx.request?.headers;
    const ip = headers ? clientIp(headers) : "unknown";

    const limit = await rateLimiter.check("emailOtpSignIn", { ip, email });
    if (!limit.allowed) throw rateLimited(limit.retryAfterSeconds);

    const deviceRaw = await readDeviceCookie(ctx, deviceCookie);
    const { user, reason } = await eligibility(email, deviceRaw);
    if (reason !== "ok") {
      await auditHooks.emailOtpFailed(
        ctx,
        user?.id ?? null,
        auditReason(reason),
      );
      throw invalidOtp();
    }
    return parsed.data;
  }

  /**
   * Better Auth's `sendVerificationOTP`. Better Auth runs it through
   * `runInBackgroundOrAwait`, which the app configures to Next's `after()`, so
   * the response never waits on it and its timing cannot show whether the
   * account exists or was eligible.
   */
  async function sendVerificationOTP(
    data: { email: string; otp: string; type: string },
    ctx?: DeviceCookieContext,
  ) {
    const email = data.email.toLowerCase();
    const recipientHash = hashRecipient(email);
    if (data.type !== "sign-in") {
      logger.warn("email_otp_unexpected_type", { type: data.type });
      return;
    }
    try {
      const deviceRaw = ctx ? await readDeviceCookie(ctx, deviceCookie) : null;
      const { reason } = await eligibility(email, deviceRaw);
      if (reason !== "ok") {
        logger.info("email_otp_skipped", {
          template: "sign-in-code",
          recipientHash,
          skipped: reason,
        });
        return;
      }
      // Capped and failed sends are logged by the mailer and never shown.
      await mailer.sendEmail({
        to: email,
        template: "sign-in-code",
        data: {
          otp: data.otp,
          expiresMinutes: EMAIL_OTP_LIFETIME_SECONDS / 60,
        },
      });
    } catch (error) {
      // The name only: the error can carry the address.
      logger.error("email_otp_send_failed", {
        recipientHash,
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }
  }

  /**
   * The after hook for `/sign-in/email-otp`: a wrong, expired or spent code.
   * The refusals of `guardSignIn` throw before this hook runs and audit
   * themselves.
   */
  async function afterSignIn(
    ctx: Parameters<typeof auditHooks.emailOtpFailed>[0],
    body: unknown,
  ) {
    if (!isAPIError(ctx.context.returned)) return;
    const parsed = signInBody.safeParse(body);
    const user = parsed.success ? await loadUser(parsed.data.email) : null;
    await auditHooks.emailOtpFailed(ctx, user?.id ?? null, "OTP_INVALID");
  }

  /**
   * The plugin answers 403 TOO_MANY_ATTEMPTS and 400 OTP_EXPIRED only when a
   * code was issued, which only an eligible address gets: an account with MFA
   * or a lock is refused by `guardSignIn` as INVALID_OTP before any code
   * exists. Left as they are, those two answers would tell an eligible address
   * from one with MFA or a lock, so both become the wrong-code answer. Called
   * after `afterSignIn`, so the audit still records OTP_INVALID. It throws, so
   * it must not run inside that hook's try/catch.
   */
  function concealCodeState(ctx: { context: { returned?: unknown } }) {
    const returned = ctx.context.returned;
    if (!isAPIError(returned)) return;
    const code = (returned.body as { code?: unknown } | undefined)?.code;
    if (typeof code === "string" && CONCEALED_CODES.has(code)) {
      throw invalidOtp();
    }
  }

  return {
    guardSend,
    guardSignIn,
    sendVerificationOTP,
    afterSignIn,
    concealCodeState,
  };
}

/**
 * The Better Auth plugin: `emailOTP`, limited to sign-in for an existing,
 * verified, non-admin account without MFA. It never creates an account. The
 * plugin's own rate limit stays at its default: Better Auth's limiter is off
 * (ENGINEERING §3) and the limits live in the before hooks below, which also
 * cover the in-process calls the server actions make.
 */
export function emailOtpPlugin(input: EmailOtpInput) {
  const otp = createEmailOtp(input);
  const plugin = emailOTP({
    otpLength: 6,
    expiresIn: EMAIL_OTP_LIFETIME_SECONDS,
    allowedAttempts: 3,
    storeOTP: "hashed",
    disableSignUp: true,
    sendVerificationOnSignUp: false,
    overrideDefaultEmailVerification: false,
    changeEmail: { enabled: false },
    sendVerificationOTP: otp.sendVerificationOTP,
  });

  return {
    ...plugin,
    hooks: {
      ...plugin.hooks,
      before: [
        {
          matcher: (ctx) => ctx.path === SEND_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = await otp.guardSend(
              ctx.body,
              ctx.headers ?? ctx.request?.headers,
            );
            return { context: { body } };
          }),
        },
        {
          matcher: (ctx) => ctx.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            const body = await otp.guardSignIn(ctx, ctx.body);
            return { context: { body } };
          }),
        },
      ],
      after: [
        ...plugin.hooks.after,
        {
          matcher: (ctx) => ctx.path === SIGN_IN_PATH,
          handler: createAuthMiddleware(async (ctx) => {
            try {
              await otp.afterSignIn(ctx, ctx.body);
            } catch {
              ctx.context.logger.error("Failed to prepare audit event", {
                path: ctx.path,
              });
            }
            otp.concealCodeState(ctx);
          }),
        },
      ],
    },
  } satisfies BetterAuthPlugin;
}
