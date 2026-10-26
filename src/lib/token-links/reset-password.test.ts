import { describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
import {
  createResetPasswordConsumer,
  loadResetPasswordView,
  resetPasswordFields,
} from "@/lib/token-links/reset-password";

const NOW = new Date("2026-10-26T12:00:00Z");
const STRONG = "correct-horse-battery-staple";
const request = new Request("http://localhost:3000/reset-password/confirm", {
  method: "POST",
});

describe("resetPasswordFields", () => {
  it("accepts matching passwords of 12 to 128 characters", () => {
    expect(
      resetPasswordFields.safeParse({
        newPassword: STRONG,
        confirmPassword: STRONG,
      }).success,
    ).toBe(true);
  });

  it.each([
    ["too short", "short", "short"],
    ["too long", "x".repeat(129), "x".repeat(129)],
    ["mismatched", STRONG, `${STRONG}!`],
  ])(
    "rejects a password that is %s",
    (_label, newPassword, confirmPassword) => {
      expect(
        resetPasswordFields.safeParse({ newPassword, confirmPassword }).success,
      ).toBe(false);
    },
  );
});

describe("loadResetPasswordView", () => {
  const dbWith = (row: { id: string } | null) => ({
    verification: { findFirst: vi.fn(async () => row) },
  });

  it("is ready for a live token", async () => {
    await expect(
      loadResetPasswordView(
        { token: "t" },
        { db: dbWith({ id: "v" }) as never, now: NOW },
      ),
    ).resolves.toEqual({ state: "ready", token: "t", fieldError: false });
  });

  it("flags a field error for the retry redirect", async () => {
    await expect(
      loadResetPasswordView(
        { token: "t", error: "fields" },
        { db: dbWith({ id: "v" }) as never, now: NOW },
      ),
    ).resolves.toMatchObject({ state: "ready", fieldError: true });
  });

  it.each([
    ["an unknown or expired token", { token: "t" }],
    ["no token", {}],
    ["a repeated token param", { token: ["a", "b"] }],
  ])("is invalid for %s", async (_label, params) => {
    await expect(
      loadResetPasswordView(params, { db: dbWith(null) as never, now: NOW }),
    ).resolves.toEqual({ state: "invalid" });
  });

  it("shows a result state without reading the token", async () => {
    const db = dbWith({ id: "v" });
    await expect(
      loadResetPasswordView(
        { result: "done", token: "t" },
        { db: db as never, now: NOW },
      ),
    ).resolves.toEqual({ state: "done" });
    expect(db.verification.findFirst).not.toHaveBeenCalled();
  });
});

describe("createResetPasswordConsumer", () => {
  const fields = { newPassword: STRONG, confirmPassword: STRONG };

  function consumerWith(resetPassword: () => Promise<unknown>) {
    const api = { resetPassword: vi.fn(resetPassword) };
    return { api, consume: createResetPasswordConsumer({ auth: { api } }) };
  }

  it("resets through Better Auth with the raw token", async () => {
    const { api, consume } = consumerWith(async () => ({ status: true }));
    await expect(consume({ token: "t", fields, request })).resolves.toEqual({
      result: "done",
    });
    expect(api.resetPassword).toHaveBeenCalledWith({
      body: { token: "t", newPassword: STRONG },
      headers: request.headers,
    });
  });

  it("retries without calling Better Auth when the passwords differ", async () => {
    const { api, consume } = consumerWith(async () => ({ status: true }));
    await expect(
      consume({
        token: "t",
        fields: { newPassword: STRONG, confirmPassword: "different-password" },
        request,
      }),
    ).resolves.toEqual({ result: "retry", error: "fields" });
    expect(api.resetPassword).not.toHaveBeenCalled();
  });

  it("maps INVALID_TOKEN to invalid", async () => {
    const { consume } = consumerWith(async () => {
      throw APIError.from("BAD_REQUEST", {
        code: "INVALID_TOKEN",
        message: "Invalid token",
      });
    });
    await expect(consume({ token: "t", fields, request })).resolves.toEqual({
      result: "invalid",
    });
  });

  it("maps a length error to a retry", async () => {
    const { consume } = consumerWith(async () => {
      throw APIError.from("BAD_REQUEST", {
        code: "PASSWORD_TOO_SHORT",
        message: "Password too short",
      });
    });
    await expect(consume({ token: "t", fields, request })).resolves.toEqual({
      result: "retry",
      error: "fields",
    });
  });

  it("rethrows anything unexpected", async () => {
    const { consume } = consumerWith(async () => {
      throw new Error("db down");
    });
    await expect(consume({ token: "t", fields, request })).rejects.toThrow(
      "db down",
    );
  });
});
