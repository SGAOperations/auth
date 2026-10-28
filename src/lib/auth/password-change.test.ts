import { beforeEach, describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  createPasswordChangeHooks,
  type PasswordChangeContext,
  type PasswordChangeSession,
} from "@/lib/auth/password-change";
import { checkSignIn, recordSuccessfulSignIn } from "@/lib/auth/lockout";
import { findDevice, readDeviceCookie } from "@/lib/auth/known-device";

vi.mock("@/lib/auth/lockout", () => ({
  checkSignIn: vi.fn(),
  recordSuccessfulSignIn: vi.fn(),
}));
vi.mock("@/lib/auth/known-device", () => ({
  findDevice: vi.fn(),
  readDeviceCookie: vi.fn(),
}));

const NOW = new Date("2026-01-01T12:00:00Z");
const session: PasswordChangeSession = {
  session: { id: "s-current" },
  user: { id: "u1", email: "a@northeastern.edu" },
};

const tx = {
  session: { deleteMany: vi.fn() },
  user: { update: vi.fn() },
};
const prisma = {
  $transaction: vi.fn((fn: (client: typeof tx) => Promise<unknown>) => fn(tx)),
} as unknown as PrismaClient;

const mailer = { sendEmail: vi.fn() };
const auditHooks = {
  passwordChanged: vi.fn(),
  passwordChangeFailed: vi.fn(),
};
const lockoutHooks = { recordFailure: vi.fn() };
const rateLimiter = { check: vi.fn() };
const logger = { error: vi.fn() };

const hooks = createPasswordChangeHooks({
  prisma,
  mailer,
  deviceCookie: { name: "sgauth-local.device", secure: false },
  // Only the adapters the hooks call are faked.
  auditHooks: auditHooks as never,
  lockoutHooks,
  rateLimiter,
  now: () => NOW,
});

function context(
  overrides: {
    body?: unknown;
    request?: Request | null;
    returned?: unknown;
    runInBackgroundOrAwait?: (task: Promise<unknown>) => unknown;
  } = {},
): PasswordChangeContext {
  const request =
    overrides.request === null
      ? undefined
      : (overrides.request ??
        new Request("http://localhost/api/auth/change-password", {
          method: "POST",
          headers: { "x-real-ip": "203.0.113.9" },
        }));
  return {
    path: "/change-password",
    body: overrides.body ?? {
      currentPassword: "the-current-password",
      newPassword: "a-brand-new-password",
      revokeOtherSessions: true,
    },
    request,
    headers: request?.headers,
    context: {
      secret: "s".repeat(32),
      logger,
      returned: overrides.returned,
      runInBackgroundOrAwait: overrides.runInBackgroundOrAwait,
    },
    getSignedCookie: vi.fn(),
  };
}

const wrongPassword = () =>
  new APIError("BAD_REQUEST", {
    code: "INVALID_PASSWORD",
    message: "Invalid password",
  });

async function thrownBy(run: () => Promise<unknown>) {
  try {
    await run();
  } catch (error) {
    return error;
  }
  throw new Error("expected a throw");
}

beforeEach(() => {
  vi.clearAllMocks();
  rateLimiter.check.mockResolvedValue({ allowed: true, retryAfterSeconds: 0 });
  vi.mocked(readDeviceCookie).mockResolvedValue(null);
  vi.mocked(findDevice).mockResolvedValue(null);
  vi.mocked(checkSignIn).mockResolvedValue({
    outcome: "proceed",
    userId: "u1",
    deviceId: null,
  });
  tx.user.update.mockResolvedValue({
    email: "a@northeastern.edu",
    name: "Avery Example",
    preferredName: null,
  });
  mailer.sendEmail.mockResolvedValue({ status: "sent" });
});

describe("before", () => {
  it("does nothing, limiter included, without a session", async () => {
    await expect(hooks.before(context(), null)).resolves.toBeUndefined();
    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(checkSignIn).not.toHaveBeenCalled();
  });

  it("checks the per-user limit once, for the session's user", async () => {
    await hooks.before(context(), session);
    expect(rateLimiter.check).toHaveBeenCalledTimes(1);
    expect(rateLimiter.check).toHaveBeenCalledWith("changePassword", {
      user: "u1",
    });
  });

  it("answers 429 with the limiter's headers and counts nothing", async () => {
    rateLimiter.check.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
    });
    const error = await thrownBy(() => hooks.before(context(), session));
    expect(error).toBeInstanceOf(APIError);
    expect(error).toMatchObject({
      status: "TOO_MANY_REQUESTS",
      body: { code: "TOO_MANY_REQUESTS" },
    });
    const headers = new Headers((error as APIError).headers);
    expect(headers.get("retry-after")).toBe("42");
    expect(headers.get("cache-control")).toBe("no-store");
    expect(checkSignIn).not.toHaveBeenCalled();
    expect(auditHooks.passwordChangeFailed).not.toHaveBeenCalled();
  });

  it("skips the limiter for a server-side call with no request", async () => {
    const result = await hooks.before(context({ request: null }), session);
    expect(rateLimiter.check).not.toHaveBeenCalled();
    expect(result).toBeDefined();
  });

  it("refuses the same password before verifying or counting", async () => {
    const body = {
      currentPassword: "the-same-password",
      newPassword: "the-same-password",
    };
    const error = await thrownBy(() =>
      hooks.before(context({ body }), session),
    );
    expect(error).toMatchObject({
      status: "BAD_REQUEST",
      body: { code: "NEW_PASSWORD_SAME_AS_CURRENT" },
    });
    expect(checkSignIn).not.toHaveBeenCalled();
  });

  it("leaves a body that does not parse to Better Auth", async () => {
    const result = await hooks.before(context({ body: { nope: 1 } }), session);
    expect(result).toBeUndefined();
    expect(checkSignIn).not.toHaveBeenCalled();
  });

  it("refuses with 403 while locked, audits it and does not count it", async () => {
    vi.mocked(checkSignIn).mockResolvedValue({
      outcome: "refuse",
      userId: "u1",
      scope: "account",
    });
    const ctx = context();
    const error = await thrownBy(() => hooks.before(ctx, session));
    expect(error).toMatchObject({
      status: "FORBIDDEN",
      body: { code: "PASSWORD_CHANGE_LOCKED" },
    });
    expect(auditHooks.passwordChangeFailed).toHaveBeenCalledWith(
      ctx,
      "u1",
      "ACCOUNT_LOCKED",
    );
    expect(lockoutHooks.recordFailure).not.toHaveBeenCalled();
  });

  it("forces revokeOtherSessions to false, even when the client sent true", async () => {
    const result = await hooks.before(context(), session);
    expect(result).toEqual({
      context: {
        body: {
          currentPassword: "the-current-password",
          newPassword: "a-brand-new-password",
          revokeOtherSessions: false,
        },
      },
    });
  });
});

describe("after", () => {
  it("does nothing without a session", async () => {
    await hooks.after(context({ returned: wrongPassword() }), null);
    expect(lockoutHooks.recordFailure).not.toHaveBeenCalled();
  });

  describe("a wrong current password", () => {
    it("counts the failure with the device and IP, then audits it", async () => {
      vi.mocked(readDeviceCookie).mockResolvedValue("raw-device");
      vi.mocked(findDevice).mockResolvedValue({
        id: "d1",
        userId: "u1",
        failedCount: 0,
        windowStartedAt: NOW,
        lockedUntil: null,
      });
      const ctx = context({ returned: wrongPassword() });

      await expect(hooks.after(ctx, session)).resolves.toBeUndefined();

      expect(lockoutHooks.recordFailure).toHaveBeenCalledTimes(1);
      expect(lockoutHooks.recordFailure).toHaveBeenCalledWith({
        userId: "u1",
        deviceId: "d1",
        ip: "203.0.113.9",
        now: NOW,
        logger,
      });
      expect(auditHooks.passwordChangeFailed).toHaveBeenCalledWith(
        ctx,
        "u1",
        "INVALID_CURRENT_PASSWORD",
      );
      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(mailer.sendEmail).not.toHaveBeenCalled();
    });

    it("ignores a device cookie that belongs to another user", async () => {
      vi.mocked(readDeviceCookie).mockResolvedValue("raw-device");
      vi.mocked(findDevice).mockResolvedValue({
        id: "d9",
        userId: "someone-else",
        failedCount: 0,
        windowStartedAt: NOW,
        lockedUntil: null,
      });
      await hooks.after(context({ returned: wrongPassword() }), session);
      expect(lockoutHooks.recordFailure).toHaveBeenCalledWith(
        expect.objectContaining({ deviceId: null }),
      );
    });
  });

  it.each(["PASSWORD_TOO_SHORT", "CREDENTIAL_ACCOUNT_NOT_FOUND"])(
    "counts nothing for %s",
    async (code) => {
      const returned = new APIError("BAD_REQUEST", { code, message: code });
      await hooks.after(context({ returned }), session);
      expect(lockoutHooks.recordFailure).not.toHaveBeenCalled();
      expect(auditHooks.passwordChangeFailed).not.toHaveBeenCalled();
      expect(prisma.$transaction).not.toHaveBeenCalled();
    },
  );

  describe("success", () => {
    it("deletes every session but the caller's, stamps and audits in one transaction", async () => {
      await hooks.after(context({ returned: { token: null } }), session);

      expect(prisma.$transaction).toHaveBeenCalledTimes(1);
      expect(tx.session.deleteMany).toHaveBeenCalledWith({
        where: { userId: "u1", id: { not: "s-current" } },
      });
      expect(tx.user.update).toHaveBeenCalledWith({
        where: { id: "u1" },
        data: { passwordChangedAt: NOW },
        select: { email: true, name: true, preferredName: true },
      });
      expect(recordSuccessfulSignIn).toHaveBeenCalledWith(tx, {
        userId: "u1",
        deviceId: null,
        now: NOW,
      });
      expect(auditHooks.passwordChanged).toHaveBeenCalledWith(
        tx,
        "u1",
        { revokedOtherSessions: true },
        expect.any(Headers),
      );
    });

    it("sends the notice after the transaction commits", async () => {
      const order: string[] = [];
      auditHooks.passwordChanged.mockImplementation(async () => {
        order.push("audit");
      });
      mailer.sendEmail.mockImplementation(async () => {
        order.push("mail");
        return { status: "sent" };
      });

      await hooks.after(context({ returned: { token: null } }), session);

      expect(order).toEqual(["audit", "mail"]);
      expect(mailer.sendEmail).toHaveBeenCalledWith({
        to: "a@northeastern.edu",
        template: "security-notice",
        data: {
          name: "Avery Example",
          event: "password-changed",
          occurredAt: NOW,
        },
      });
    });

    it("hands the notice to the background runner when there is one", async () => {
      const runInBackgroundOrAwait = vi.fn();
      await hooks.after(
        context({ returned: { token: null }, runInBackgroundOrAwait }),
        session,
      );
      expect(runInBackgroundOrAwait).toHaveBeenCalledTimes(1);
    });

    it("swallows a throwing mailer and logs without the error", async () => {
      mailer.sendEmail.mockRejectedValue(
        new Error("a@northeastern.edu bounced"),
      );
      await expect(
        hooks.after(context({ returned: { token: null } }), session),
      ).resolves.toBeUndefined();
      expect(logger.error).toHaveBeenCalledWith(
        "Failed to send password-changed notice",
      );
    });

    it("rejects when the transaction fails, and sends no notice", async () => {
      tx.session.deleteMany.mockRejectedValue(new Error("db down"));
      await expect(
        hooks.after(context({ returned: { token: null } }), session),
      ).rejects.toThrow("db down");
      expect(mailer.sendEmail).not.toHaveBeenCalled();
    });
  });
});
