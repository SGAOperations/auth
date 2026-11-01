import { describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
import { createSecurityNoticeHooks } from "@/lib/auth/security-notices";
import { createCapturingMailer } from "@/test/capturing-mailer";

const AT = new Date("2026-10-26T12:00:00Z");
const USER = {
  email: "avery@northeastern.edu",
  name: "Avery Jones",
  preferredName: "Avery",
};

function setup(user: typeof USER | null = USER) {
  const mailer = createCapturingMailer();
  const prisma = { user: { findUnique: vi.fn(async () => user) } };
  const hooks = createSecurityNoticeHooks({
    prisma: prisma as never,
    mailer,
    now: () => AT,
  });
  const logger = { error: vi.fn() };
  const ctx = (overrides: {
    path: string;
    returned?: unknown;
    session?: { user: { id: string } } | null;
  }) => ({
    path: overrides.path,
    context: {
      logger,
      returned: overrides.returned,
      session: overrides.session ?? null,
    },
  });
  return { mailer, prisma, hooks, logger, ctx };
}

const notice = (event: string) => ({
  to: USER.email,
  template: "security-notice",
  data: { name: "Avery", event, occurredAt: AT },
});

describe("createSecurityNoticeHooks", () => {
  it("announces a new passkey to the owner the endpoint returned", async () => {
    const { mailer, prisma, hooks, ctx } = setup();
    await hooks.afterEndpoint(
      ctx({
        path: "/passkey/verify-registration",
        returned: { id: "pk1", userId: "u1" },
      }),
    );
    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: "u1" },
      select: { email: true, name: true, preferredName: true },
    });
    expect(mailer.sent).toEqual([notice("passkey-added")]);
  });

  it("announces a removed passkey to the session's user", async () => {
    const { mailer, hooks, ctx } = setup();
    await hooks.afterEndpoint(
      ctx({
        path: "/passkey/delete-passkey",
        returned: { status: true },
        session: { user: { id: "u1" } },
      }),
    );
    expect(mailer.sent).toEqual([notice("passkey-removed")]);
  });

  it("sends nothing for a failed endpoint or another path", async () => {
    const { mailer, hooks, ctx } = setup();
    await hooks.afterEndpoint(
      ctx({
        path: "/passkey/delete-passkey",
        returned: new APIError("NOT_FOUND"),
        session: { user: { id: "u1" } },
      }),
    );
    await hooks.afterEndpoint(
      ctx({ path: "/sign-in/email", returned: { user: { id: "u1" } } }),
    );
    expect(mailer.sent).toEqual([]);
  });

  it("announces MFA turning on at verify-totp and off at disable", async () => {
    const { mailer, hooks, ctx } = setup();
    await hooks.userUpdated(
      { id: "u1", twoFactorEnabled: true },
      ctx({ path: "/two-factor/verify-totp" }),
    );
    await hooks.userUpdated(
      { id: "u1", twoFactorEnabled: false },
      ctx({ path: "/two-factor/disable" }),
    );
    expect(mailer.sent).toEqual([
      notice("mfa-enabled"),
      notice("mfa-disabled"),
    ]);
  });

  it("sends nothing for an update that is not an MFA transition", async () => {
    const { mailer, hooks, ctx } = setup();
    await hooks.userUpdated(
      { id: "u1", twoFactorEnabled: true },
      ctx({ path: "/update-user" }),
    );
    await hooks.userUpdated({ id: "u1", twoFactorEnabled: true }, null);
    expect(mailer.sent).toEqual([]);
  });

  it("logs a failed send with the event only and never throws", async () => {
    const { prisma, logger, ctx } = setup();
    const hooks = createSecurityNoticeHooks({
      prisma: prisma as never,
      mailer: {
        sendEmail: async () => {
          throw new Error("avery@northeastern.edu");
        },
      },
      now: () => AT,
    });
    await expect(
      hooks.userUpdated(
        { id: "u1", twoFactorEnabled: false },
        ctx({ path: "/two-factor/disable" }),
      ),
    ).resolves.toBeUndefined();
    expect(logger.error).toHaveBeenCalledWith(
      "Failed to send security notice",
      {
        event: "mfa-disabled",
      },
    );
  });
});
