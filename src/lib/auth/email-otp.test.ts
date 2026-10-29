import { APIError, isAPIError } from "better-auth/api";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  EMAIL_OTP_DISABLED_PATHS,
  createEmailOtp,
  sendCounterKey,
  type EmailOtpInput,
} from "@/lib/auth/email-otp";
import { createMemoryCapStore, type CapStore } from "@/lib/email/caps";
import { hashRecipient } from "@/lib/email/mailer";
import { createRateLimiter } from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";

const audit = vi.hoisted(() => vi.fn());
vi.mock("@/lib/audit", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/audit")>()),
  audit,
}));

const EMAIL = "avery@northeastern.edu";
const NOW = new Date("2026-11-03T15:00:00Z");

const eligibleUser = {
  id: "user-1",
  status: "ACTIVE",
  emailVerified: true,
  isAdmin: false,
  isPrimaryAdmin: false,
  twoFactorEnabled: false,
  accountLock: null as { lockedUntil: Date | null } | null,
};

type UserRow = typeof eligibleUser;

function prismaWith(user: UserRow | null) {
  return {
    user: { findUnique: vi.fn(async () => user) },
    knownDevice: { findUnique: vi.fn(async () => null) },
  } as unknown as PrismaClient;
}

function build(overrides: Partial<EmailOtpInput> & { user?: UserRow | null }) {
  const { user = eligibleUser, ...rest } = overrides;
  const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const mailer = {
    sendEmail: vi.fn(async () => ({ status: "sent" as const })),
  };
  const input: EmailOtpInput = {
    prisma: prismaWith(user),
    settings: { dailyCap: 100 },
    rateLimiter: createRateLimiter({
      backend: createMemoryBackend(),
      log: { error() {} },
    }),
    capStore: createMemoryCapStore(),
    mailer,
    deviceCookie: { name: "device", secure: false },
    logger,
    now: () => NOW,
    ...rest,
  };
  return { otp: createEmailOtp(input), logger, mailer };
}

function headersFor(ip: string) {
  return new Headers({ "x-real-ip": ip });
}

async function caught(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (error) {
    if (isAPIError(error)) return error;
    throw error;
  }
  throw new Error("expected an APIError");
}

function signInCtx(ip = "203.0.113.5") {
  return {
    path: "/sign-in/email-otp",
    headers: headersFor(ip),
    context: {
      secret: "s".repeat(32),
      logger: { error: vi.fn() },
      returned: undefined as unknown,
    },
    getSignedCookie: vi.fn(async () => null),
  };
}

beforeEach(() => {
  audit.mockReset();
});

describe("EMAIL_OTP_DISABLED_PATHS", () => {
  it("shuts every route but send and sign-in", () => {
    expect([...EMAIL_OTP_DISABLED_PATHS].sort()).toEqual([
      "/email-otp/change-email",
      "/email-otp/check-verification-otp",
      "/email-otp/request-email-change",
      "/email-otp/request-password-reset",
      "/email-otp/reset-password",
      "/email-otp/verify-email",
      "/forget-password/email-otp",
    ]);
  });
});

describe("guardSend", () => {
  it("lowercases the email and lets an in-limit request through", async () => {
    const { otp } = build({});
    const body = await otp.guardSend(
      { email: "  Avery@Northeastern.edu ", type: "sign-in" },
      headersFor("203.0.113.5"),
    );
    expect(body).toMatchObject({ email: EMAIL, type: "sign-in" });
  });

  it.each([
    [{ email: EMAIL, type: "email-verification" }],
    [{ email: EMAIL, type: "forget-password" }],
    [{ email: EMAIL }],
    [{ type: "sign-in" }],
    [null],
  ])("refuses the body %j with 400 INVALID_REQUEST", async (body) => {
    const { otp } = build({});
    const error = await caught(otp.guardSend(body, headersFor("203.0.113.5")));
    expect(error.statusCode).toBe(400);
    expect(error.body).toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("answers the 4th send for one email in 15 minutes with 429 and Retry-After", async () => {
    const { otp } = build({});
    const send = (ip: string) =>
      otp.guardSend({ email: EMAIL, type: "sign-in" }, headersFor(ip));
    // Three different IPs, so only the per-email bucket is in play.
    await send("203.0.113.1");
    await send("203.0.113.2");
    await send("203.0.113.3");
    const error = await caught(send("203.0.113.4"));
    expect(error.statusCode).toBe(429);
    expect(
      Number(new Headers(error.headers).get("retry-after")),
    ).toBeGreaterThan(0);
  });

  it("limits one IP to 10 sends an hour across addresses", async () => {
    const { otp } = build({});
    for (let i = 0; i < 10; i += 1) {
      await otp.guardSend(
        { email: `user${i}@northeastern.edu`, type: "sign-in" },
        headersFor("203.0.113.9"),
      );
    }
    const error = await caught(
      otp.guardSend(
        { email: "user11@northeastern.edu", type: "sign-in" },
        headersFor("203.0.113.9"),
      ),
    );
    expect(error.statusCode).toBe(429);
  });

  it("allows the cap-th send and refuses the next with the same 503 for every address", async () => {
    const { otp } = build({ settings: { dailyCap: 2 } });
    await otp.guardSend(
      { email: "a@northeastern.edu", type: "sign-in" },
      headersFor("203.0.113.1"),
    );
    await otp.guardSend(
      { email: "b@northeastern.edu", type: "sign-in" },
      headersFor("203.0.113.2"),
    );
    const first = await caught(
      otp.guardSend(
        { email: "c@northeastern.edu", type: "sign-in" },
        headersFor("203.0.113.3"),
      ),
    );
    const second = await caught(
      otp.guardSend(
        { email: EMAIL, type: "sign-in" },
        headersFor("203.0.113.4"),
      ),
    );
    expect(first.statusCode).toBe(503);
    expect(first.body).toMatchObject({ code: "EMAIL_OTP_UNAVAILABLE" });
    expect(second.body).toEqual(first.body);
  });

  it("fails closed with 503 and an alert when the counter store is down", async () => {
    const capStore: CapStore = {
      incr: async () => {
        throw new Error("redis unreachable");
      },
    };
    const { otp, logger } = build({ capStore });
    const error = await caught(
      otp.guardSend(
        { email: EMAIL, type: "sign-in" },
        headersFor("203.0.113.5"),
      ),
    );
    expect(error.statusCode).toBe(503);
    expect(error.body).toMatchObject({ code: "EMAIL_OTP_UNAVAILABLE" });
    expect(logger.error).toHaveBeenCalledWith(
      "[ALERT] email-otp send counter unavailable",
      { errorName: "Error" },
    );
  });

  it("counts under a key per UTC day", () => {
    expect(sendCounterKey(NOW)).toBe("email-otp:sends:2026-11-03");
  });
});

describe("guardSignIn", () => {
  it("lets an eligible account's request through", async () => {
    const { otp } = build({});
    const body = await otp.guardSignIn(signInCtx(), {
      email: "Avery@Northeastern.edu",
      otp: "123456",
    });
    expect(body).toMatchObject({ email: EMAIL, otp: "123456" });
    expect(audit).not.toHaveBeenCalled();
  });

  it.each([
    ["an MFA user", { ...eligibleUser, twoFactorEnabled: true }, "OTP_MFA"],
    ["an admin", { ...eligibleUser, isAdmin: true }, "OTP_ADMIN"],
    [
      "the Primary Admin",
      { ...eligibleUser, isPrimaryAdmin: true },
      "OTP_ADMIN",
    ],
    [
      "an unverified account",
      { ...eligibleUser, emailVerified: false },
      "OTP_UNVERIFIED",
    ],
    [
      "a deactivated account",
      { ...eligibleUser, status: "DEACTIVATED" },
      "OTP_INACTIVE",
    ],
    [
      "a locked account without a device exemption",
      {
        ...eligibleUser,
        accountLock: { lockedUntil: new Date(NOW.getTime() + 60_000) },
      },
      "OTP_LOCKED",
    ],
  ])(
    "refuses %s with INVALID_OTP and audits the rule",
    async (_name, user, reason) => {
      const { otp } = build({ user });
      const error = await caught(
        otp.guardSignIn(signInCtx(), { email: EMAIL, otp: "123456" }),
      );
      expect(error.statusCode).toBe(400);
      expect(error.body).toMatchObject({ code: "INVALID_OTP" });
      expect(audit).toHaveBeenCalledWith(
        expect.objectContaining({
          type: "LOGIN_FAILED",
          metadata: { method: "email_otp", reason },
          targetType: "USER",
          targetId: "user-1",
        }),
        expect.anything(),
      );
    },
  );

  it("refuses an unknown address the same way, with no target", async () => {
    const { otp } = build({ user: null });
    const error = await caught(
      otp.guardSignIn(signInCtx(), { email: EMAIL, otp: "123456" }),
    );
    expect(error.body).toMatchObject({ code: "INVALID_OTP" });
    const event = audit.mock.calls[0][0];
    expect(event.metadata).toEqual({
      method: "email_otp",
      reason: "OTP_NO_ACCOUNT",
    });
    expect(event.targetId).toBeUndefined();
  });

  it("limits sign-in attempts per email to 10 in 15 minutes", async () => {
    const { otp } = build({});
    for (let i = 0; i < 10; i += 1) {
      await otp.guardSignIn(signInCtx(`203.0.113.${i}`), {
        email: EMAIL,
        otp: "123456",
      });
    }
    const error = await caught(
      otp.guardSignIn(signInCtx("203.0.113.200"), {
        email: EMAIL,
        otp: "123456",
      }),
    );
    expect(error.statusCode).toBe(429);
  });

  it("refuses a body with no code as a 400", async () => {
    const { otp } = build({});
    const error = await caught(otp.guardSignIn(signInCtx(), { email: EMAIL }));
    expect(error.body).toMatchObject({ code: "INVALID_REQUEST" });
  });
});

describe("sendVerificationOTP", () => {
  it("mails the code to an eligible account", async () => {
    const { otp, mailer } = build({});
    await otp.sendVerificationOTP({
      email: "Avery@Northeastern.edu",
      otp: "123456",
      type: "sign-in",
    });
    expect(mailer.sendEmail).toHaveBeenCalledWith({
      to: EMAIL,
      template: "sign-in-code",
      data: { otp: "123456", expiresMinutes: 10 },
    });
  });

  it.each([
    ["an MFA user", { ...eligibleUser, twoFactorEnabled: true }, "mfa"],
    ["an admin", { ...eligibleUser, isAdmin: true }, "admin"],
    ["an unknown address", null, "no_account"],
  ])(
    "sends nothing to %s and logs the reason",
    async (_name, user, skipped) => {
      const { otp, mailer, logger } = build({ user });
      await otp.sendVerificationOTP({
        email: EMAIL,
        otp: "123456",
        type: "sign-in",
      });
      expect(mailer.sendEmail).not.toHaveBeenCalled();
      expect(logger.info).toHaveBeenCalledWith("email_otp_skipped", {
        template: "sign-in-code",
        recipientHash: hashRecipient(EMAIL),
        skipped,
      });
    },
  );

  it("warns and sends nothing for any other type", async () => {
    const { otp, mailer, logger } = build({});
    await otp.sendVerificationOTP({
      email: EMAIL,
      otp: "123456",
      type: "forget-password",
    });
    expect(mailer.sendEmail).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledWith("email_otp_unexpected_type", {
      type: "forget-password",
    });
  });

  it("logs a mailer failure by hash and never throws", async () => {
    const { otp, logger, mailer } = build({});
    mailer.sendEmail.mockRejectedValueOnce(new TypeError("boom avery@x.edu"));
    await expect(
      otp.sendVerificationOTP({
        email: EMAIL,
        otp: "123456",
        type: "sign-in",
      }),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith("email_otp_send_failed", {
      recipientHash: hashRecipient(EMAIL),
      errorName: "TypeError",
    });
  });
});

describe("afterSignIn", () => {
  it("audits a wrong code against the account", async () => {
    const { otp } = build({});
    const ctx = signInCtx();
    ctx.context.returned = APIError.from("BAD_REQUEST", {
      code: "INVALID_OTP",
      message: "Invalid OTP",
    });
    await otp.afterSignIn(ctx, { email: EMAIL, otp: "000000" });
    expect(audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "LOGIN_FAILED",
        metadata: { method: "email_otp", reason: "OTP_INVALID" },
        targetId: "user-1",
      }),
      expect.anything(),
    );
  });

  it("writes nothing for a successful sign-in", async () => {
    const { otp } = build({});
    const ctx = signInCtx();
    ctx.context.returned = { token: "t", user: { id: "user-1" } };
    await otp.afterSignIn(ctx, { email: EMAIL, otp: "123456" });
    expect(audit).not.toHaveBeenCalled();
  });
});
