import { describe, expect, it, vi } from "vitest";
import {
  PASSKEY_COPY,
  addedLabel,
  mapAddPasskeyError,
  mapManagePasskeyError,
  mapPasskeySignInError,
  removeConfirmation,
  withReauthRetry,
} from "@/lib/auth/passkey-ui";

describe("mapPasskeySignInError", () => {
  it.each([
    "AUTH_CANCELLED",
    "ERROR_CEREMONY_ABORTED",
    "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY",
  ])("is silent for a cancelled ceremony (%s)", (code) => {
    expect(mapPasskeySignInError({ code, status: 400 })).toEqual({
      kind: "silent",
    });
  });

  it("shows one line for every server rejection", () => {
    for (const code of [
      "PASSKEY_NOT_FOUND",
      "AUTHENTICATION_FAILED",
      "PASSKEY_USER_VERIFICATION_REQUIRED",
      "CHALLENGE_NOT_FOUND",
    ]) {
      expect(mapPasskeySignInError({ code, status: 401 })).toEqual({
        kind: "message",
        message: PASSKEY_COPY.signInFailed,
      });
    }
  });

  it("names a rate limit", () => {
    expect(mapPasskeySignInError({ status: 429 })).toEqual({
      kind: "message",
      message: PASSKEY_COPY.rateLimited,
    });
  });

  it("falls back to the same line for an error with no code", () => {
    expect(mapPasskeySignInError({ status: 500 })).toEqual({
      kind: "message",
      message: PASSKEY_COPY.signInFailed,
    });
  });
});

describe("mapAddPasskeyError", () => {
  it("names an authenticator that already holds a passkey", () => {
    expect(
      mapAddPasskeyError({ code: "ERROR_AUTHENTICATOR_PREVIOUSLY_REGISTERED" }),
    ).toEqual({ kind: "message", message: PASSKEY_COPY.alreadyOnDevice });
  });

  it("is silent when the prompt is dismissed", () => {
    expect(mapAddPasskeyError({ code: "ERROR_CEREMONY_ABORTED" })).toEqual({
      kind: "silent",
    });
    expect(
      mapAddPasskeyError({ code: "ERROR_PASSTHROUGH_SEE_CAUSE_PROPERTY" }),
    ).toEqual({ kind: "silent" });
  });

  it("is silent when the re-auth prompt was cancelled", () => {
    expect(
      mapAddPasskeyError({ code: "REAUTH_REQUIRED", status: 403 }),
    ).toEqual({ kind: "silent" });
  });

  it("asks for a new sign-in when the session is too old", () => {
    expect(
      mapAddPasskeyError({ code: "SESSION_NOT_FRESH", status: 403 }),
    ).toEqual({ kind: "message", message: PASSKEY_COPY.signInAgain });
  });

  it("names the limit", () => {
    expect(
      mapAddPasskeyError({ code: "PASSKEY_LIMIT_REACHED", status: 400 }),
    ).toEqual({ kind: "message", message: PASSKEY_COPY.limitReached });
  });

  it("falls back to the generic line", () => {
    expect(mapAddPasskeyError({ status: 500 })).toEqual({
      kind: "message",
      message: PASSKEY_COPY.addFailed,
    });
  });
});

describe("mapManagePasskeyError", () => {
  it("is silent when the re-auth prompt was cancelled", () => {
    expect(
      mapManagePasskeyError({ code: "REAUTH_REQUIRED", status: 403 }),
    ).toEqual({ kind: "silent" });
  });

  it("shows one line for anything else", () => {
    expect(mapManagePasskeyError({ code: "PASSKEY_NOT_FOUND" })).toEqual({
      kind: "message",
      message: PASSKEY_COPY.updateFailed,
    });
  });
});

describe("withReauthRetry", () => {
  const required = { error: { code: "REAUTH_REQUIRED", status: 403 } };
  const ok = { error: null, value: 1 };

  it("returns the first result when nothing is required", async () => {
    const call = vi.fn().mockResolvedValue(ok);
    const prompt = vi.fn();
    await expect(withReauthRetry(call, prompt)).resolves.toBe(ok);
    expect(call).toHaveBeenCalledTimes(1);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("does not prompt for another error", async () => {
    const failed = { error: { code: "PASSKEY_LIMIT_REACHED", status: 400 } };
    const call = vi.fn().mockResolvedValue(failed);
    const prompt = vi.fn();
    await expect(withReauthRetry(call, prompt)).resolves.toBe(failed);
    expect(prompt).not.toHaveBeenCalled();
  });

  it("prompts, then retries once", async () => {
    const call = vi.fn().mockResolvedValueOnce(required).mockResolvedValue(ok);
    const prompt = vi.fn().mockResolvedValue(true);
    await expect(withReauthRetry(call, prompt)).resolves.toBe(ok);
    expect(call).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledTimes(1);
  });

  it("returns the original error when the prompt is cancelled", async () => {
    const call = vi.fn().mockResolvedValue(required);
    const prompt = vi.fn().mockResolvedValue(false);
    await expect(withReauthRetry(call, prompt)).resolves.toBe(required);
    expect(call).toHaveBeenCalledTimes(1);
  });

  it("does not loop on a second REAUTH_REQUIRED", async () => {
    const call = vi.fn().mockResolvedValue(required);
    const prompt = vi.fn().mockResolvedValue(true);
    await expect(withReauthRetry(call, prompt)).resolves.toBe(required);
    expect(call).toHaveBeenCalledTimes(2);
    expect(prompt).toHaveBeenCalledTimes(1);
  });
});

describe("addedLabel", () => {
  it("prints the UTC date as Mon D, YYYY", () => {
    expect(addedLabel("2026-10-28T23:59:59.000Z")).toBe("Added Oct 28, 2026");
    expect(addedLabel(new Date("2026-01-05T00:00:00.000Z"))).toBe(
      "Added Jan 5, 2026",
    );
  });
});

describe("removeConfirmation", () => {
  it("quotes the name", () => {
    expect(removeConfirmation("MacBook")).toBe(
      `Remove "MacBook"? You won't be able to sign in with it anymore. Your password and any other passkeys still work.`,
    );
  });

  it("names an unnamed passkey", () => {
    expect(removeConfirmation(null)).toContain('"Unnamed passkey"');
  });
});
