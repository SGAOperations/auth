import { APIError } from "better-auth/api";
import { describe, expect, it, vi } from "vitest";
import { createAuthAnalyticsHooks } from "@/lib/auth/analytics-hooks";
import type { HookContext } from "@/lib/auth/audit-hooks";

const USER_ID = "3f2b8c1e-5d4a-4e6f-9a7b-1c2d3e4f5a6b";

function setup() {
  const capture = vi.fn();
  return { capture, hooks: createAuthAnalyticsHooks({ capture }) };
}

function ctx(path: string, returned?: unknown): HookContext {
  return {
    path,
    context: { logger: { error: () => {} }, returned },
  };
}

const failure = (code: string) =>
  APIError.from("UNAUTHORIZED", { code, message: "x" });

describe("afterEndpoint", () => {
  it("emits an anonymous login_failed with the safe reason", () => {
    const { capture, hooks } = setup();
    hooks.afterEndpoint(
      ctx("/sign-in/email", failure("INVALID_EMAIL_OR_PASSWORD")),
    );
    expect(capture).toHaveBeenCalledExactlyOnceWith("login_failed", {
      properties: { reason: "INVALID_EMAIL_OR_PASSWORD" },
    });
  });

  it("falls back to OTHER for an unknown failure code", () => {
    const { capture, hooks } = setup();
    hooks.afterEndpoint(ctx("/sign-in/email", failure("SOMETHING_ELSE")));
    expect(capture).toHaveBeenCalledWith("login_failed", {
      properties: { reason: "OTHER" },
    });
  });

  it("emits nothing for a successful sign-in", () => {
    const { capture, hooks } = setup();
    hooks.afterEndpoint(ctx("/sign-in/email", { token: "t" }));
    expect(capture).not.toHaveBeenCalled();
  });

  it("emits an anonymous reset_requested on success", () => {
    const { capture, hooks } = setup();
    hooks.afterEndpoint(ctx("/request-password-reset", { status: true }));
    expect(capture).toHaveBeenCalledExactlyOnceWith("reset_requested", {
      properties: {},
    });
  });

  it("emits nothing when a reset request returns an error", () => {
    const { capture, hooks } = setup();
    hooks.afterEndpoint(
      ctx("/request-password-reset", failure("RATE_LIMITED")),
    );
    expect(capture).not.toHaveBeenCalled();
  });

  it("emits nothing for an unrelated path", () => {
    const { capture, hooks } = setup();
    hooks.afterEndpoint(ctx("/get-session", { user: {} }));
    expect(capture).not.toHaveBeenCalled();
  });

  it("never throws when analytics does", () => {
    const hooks = createAuthAnalyticsHooks({
      capture: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      hooks.afterEndpoint(ctx("/request-password-reset", { status: true })),
    ).not.toThrow();
  });
});

describe("sessionCreated", () => {
  const session = { id: "s1", userId: USER_ID };

  it("maps the sign-in path to the password method", () => {
    const { capture, hooks } = setup();
    hooks.sessionCreated(session, ctx("/sign-in/email"));
    expect(capture).toHaveBeenCalledExactlyOnceWith("login_succeeded", {
      userId: USER_ID,
      properties: { method: "password" },
    });
  });

  it("maps email verification to its own method", () => {
    const { capture, hooks } = setup();
    hooks.sessionCreated(session, ctx("/verify-email"));
    expect(capture).toHaveBeenCalledWith("login_succeeded", {
      userId: USER_ID,
      properties: { method: "email_verification" },
    });
  });

  it("uses other for any other path or no context", () => {
    const { capture, hooks } = setup();
    hooks.sessionCreated(session, ctx("/sign-in/magic-link"));
    hooks.sessionCreated(session, null);
    expect(capture).toHaveBeenNthCalledWith(1, "login_succeeded", {
      userId: USER_ID,
      properties: { method: "other" },
    });
    expect(capture).toHaveBeenNthCalledWith(2, "login_succeeded", {
      userId: USER_ID,
      properties: { method: "other" },
    });
  });

  it("never throws when analytics does", () => {
    const hooks = createAuthAnalyticsHooks({
      capture: () => {
        throw new Error("boom");
      },
    });
    expect(() => hooks.sessionCreated(session, null)).not.toThrow();
  });
});

describe("userCreated", () => {
  it("emits signup_started for self sign-up", () => {
    const { capture, hooks } = setup();
    hooks.userCreated({ id: USER_ID }, ctx("/sign-up/email"));
    expect(capture).toHaveBeenCalledExactlyOnceWith("signup_started", {
      userId: USER_ID,
      properties: {},
    });
  });

  it("emits nothing for an admin or system creation path", () => {
    const { capture, hooks } = setup();
    hooks.userCreated({ id: USER_ID }, ctx("/admin/create-user"));
    hooks.userCreated({ id: USER_ID }, null);
    expect(capture).not.toHaveBeenCalled();
  });

  it("never throws when analytics does", () => {
    const hooks = createAuthAnalyticsHooks({
      capture: () => {
        throw new Error("boom");
      },
    });
    expect(() =>
      hooks.userCreated({ id: USER_ID }, ctx("/sign-up/email")),
    ).not.toThrow();
  });
});

describe("emailVerified and passwordReset", () => {
  it("emits signup_completed with the user id", () => {
    const { capture, hooks } = setup();
    hooks.emailVerified({ id: USER_ID });
    expect(capture).toHaveBeenCalledExactlyOnceWith("signup_completed", {
      userId: USER_ID,
      properties: {},
    });
  });

  it("emits reset_completed with the user id", () => {
    const { capture, hooks } = setup();
    hooks.passwordReset({ user: { id: USER_ID } });
    expect(capture).toHaveBeenCalledExactlyOnceWith("reset_completed", {
      userId: USER_ID,
      properties: {},
    });
  });

  it("never throws when analytics does", () => {
    const hooks = createAuthAnalyticsHooks({
      capture: () => {
        throw new Error("boom");
      },
    });
    expect(() => hooks.emailVerified({ id: USER_ID })).not.toThrow();
    expect(() => hooks.passwordReset({ user: { id: USER_ID } })).not.toThrow();
  });
});
