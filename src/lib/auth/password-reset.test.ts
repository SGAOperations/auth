import { describe, expect, it, vi } from "vitest";
import {
  RESET_PASSWORD_VERIFICATION_STORAGE,
  createOnPasswordReset,
  createSendResetPassword,
  isResetTokenUsable,
  resetTokenStoredIdentifier,
} from "@/lib/auth/password-reset";
import { createCapturingMailer } from "@/test/capturing-mailer";

const ORIGIN = "http://localhost:3000";

describe("resetTokenStoredIdentifier", () => {
  const token = "AbCdEfGhIjKlMnOpQrStUvWx";

  it("is deterministic, unpadded base64url, and 43 characters", () => {
    const stored = resetTokenStoredIdentifier(token);
    expect(stored).toBe(resetTokenStoredIdentifier(token));
    expect(stored).toMatch(/^[A-Za-z0-9_-]{43}$/);
  });

  it("does not contain the token or the prefix", () => {
    const stored = resetTokenStoredIdentifier(token);
    expect(stored).not.toContain(token);
    expect(stored.startsWith("reset-password:")).toBe(false);
  });

  it("differs per token", () => {
    expect(resetTokenStoredIdentifier("a")).not.toBe(
      resetTokenStoredIdentifier("b"),
    );
  });
});

describe("RESET_PASSWORD_VERIFICATION_STORAGE", () => {
  it("hashes only the reset-password prefix", () => {
    expect(RESET_PASSWORD_VERIFICATION_STORAGE).toEqual({
      default: "plain",
      overrides: { "reset-password:": "hashed" },
    });
  });
});

describe("createSendResetPassword", () => {
  function setup() {
    const mailer = createCapturingMailer();
    const logger = { error: vi.fn() };
    const send = createSendResetPassword({
      mailer,
      linkOrigin: ORIGIN,
      logger,
    });
    return { mailer, logger, send };
  }

  it("sends one reset email with the page link to an ACTIVE user", async () => {
    const { mailer, send } = setup();
    await send({
      user: {
        email: "avery@northeastern.edu",
        name: "Avery",
        status: "ACTIVE",
      },
      token: "tok en",
    });
    expect(mailer.sent).toEqual([
      {
        to: "avery@northeastern.edu",
        template: "reset-password",
        data: {
          name: "Avery",
          url: `${ORIGIN}/reset-password?token=tok%20en`,
          expiresInMinutes: 60,
        },
      },
    ]);
  });

  it.each([
    [
      "a deactivated user",
      { email: "a@northeastern.edu", status: "DEACTIVATED" },
    ],
    ["a deleted user", { email: "a@northeastern.edu", status: "DELETED" }],
    ["an unparseable user", { name: "No email" }],
  ])("sends nothing for %s", async (_label, user) => {
    const { mailer, send } = setup();
    await send({ user, token: "t" });
    expect(mailer.sent).toEqual([]);
  });

  it("logs a send failure with the error class only", async () => {
    const { logger } = setup();
    const send = createSendResetPassword({
      mailer: {
        sendEmail: async () => {
          throw new TypeError("secret@northeastern.edu");
        },
      },
      linkOrigin: ORIGIN,
      logger,
    });
    await send({
      user: { email: "a@northeastern.edu", status: "ACTIVE" },
      token: "t",
    });
    expect(logger.error).toHaveBeenCalledWith("password_reset_email_failed", {
      errorName: "TypeError",
    });
  });
});

describe("createOnPasswordReset", () => {
  const user = { id: "u1", email: "avery@northeastern.edu", name: "Avery" };
  const at = new Date("2026-10-26T12:00:00Z");

  function setup() {
    const calls: string[] = [];
    const prisma = {
      session: {
        deleteMany: vi.fn(async () => {
          calls.push("sessions");
        }),
      },
      user: {
        update: vi.fn(async () => {
          calls.push("stamp");
        }),
      },
    };
    const afterReset = vi.fn(async () => {
      calls.push("after");
    });
    const mailer = createCapturingMailer();
    const run = createOnPasswordReset({
      // The two delegates are the only parts of the client this reads.
      prisma: prisma as never,
      mailer,
      afterReset,
      now: () => at,
    });
    return { calls, prisma, afterReset, mailer, run };
  }

  it("revokes sessions, stamps the change, runs the hooks, then sends the notice", async () => {
    const { calls, prisma, mailer, run } = setup();
    await run({ user });
    expect(calls).toEqual(["sessions", "stamp", "after"]);
    expect(prisma.session.deleteMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
    });
    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: "u1" },
      data: { passwordChangedAt: at },
    });
    expect(mailer.sent).toEqual([
      {
        to: "avery@northeastern.edu",
        template: "security-notice",
        data: { name: "Avery", event: "password-reset", occurredAt: at },
      },
    ]);
  });

  it("runs nothing else when the session delete throws", async () => {
    const { prisma, afterReset, mailer, run } = setup();
    prisma.session.deleteMany.mockRejectedValueOnce(new Error("db down"));
    await expect(run({ user })).rejects.toThrow("db down");
    expect(prisma.user.update).not.toHaveBeenCalled();
    expect(afterReset).not.toHaveBeenCalled();
    expect(mailer.sent).toEqual([]);
  });

  it("swallows a notice failure", async () => {
    const { prisma, afterReset } = setup();
    const error = vi.spyOn(console, "error").mockImplementation(() => {});
    const run = createOnPasswordReset({
      prisma: prisma as never,
      mailer: {
        sendEmail: async () => {
          throw new Error("boom");
        },
      },
      afterReset,
      now: () => at,
    });
    await expect(run({ user })).resolves.toBeUndefined();
    expect(error).toHaveBeenCalledWith("password_reset_notice_failed", {
      errorName: "Error",
    });
    error.mockRestore();
  });
});

describe("isResetTokenUsable", () => {
  it("queries by the hashed identifier, never the plain one", async () => {
    const findFirst = vi.fn(async () => ({ id: "v1" }));
    const now = new Date("2026-10-26T12:00:00Z");
    await expect(
      isResetTokenUsable({ verification: { findFirst } } as never, "tok", now),
    ).resolves.toBe(true);
    expect(findFirst).toHaveBeenCalledWith({
      where: {
        identifier: resetTokenStoredIdentifier("tok"),
        expiresAt: { gt: now },
      },
      select: { id: true },
    });
  });

  it("is false when no row matches", async () => {
    const findFirst = vi.fn(async () => null);
    await expect(
      isResetTokenUsable({ verification: { findFirst } } as never, "tok"),
    ).resolves.toBe(false);
  });
});
