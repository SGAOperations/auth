import { describe, expect, it, vi } from "vitest";
import {
  backupCodesFileText,
  backupCodesStatus,
  groupKey,
  normalizeTotpInput,
  parseEnableResponse,
  parseRegenerateResponse,
  parseSecurityReason,
  parseTotpUri,
  postSecurity,
  searchParamsSchema,
  securityErrorCopy,
  totpCodeSchema,
  verifyCodeSchema,
} from "@/lib/account/security-ui";

describe("parseTotpUri", () => {
  it("reads a valid URI", () => {
    expect(
      parseTotpUri(
        "otpauth://totp/SGAuth%20(local):a%40husky.neu.edu?secret=JBSWY3DPEHPK3PXP&issuer=SGAuth%20(local)",
      ),
    ).toEqual({
      secret: "JBSWY3DPEHPK3PXP",
      issuer: "SGAuth (local)",
      account: "a@husky.neu.edu",
    });
  });

  it("returns null without a secret", () => {
    expect(parseTotpUri("otpauth://totp/SGAuth:a?issuer=SGAuth")).toBeNull();
  });

  it("returns null for another protocol", () => {
    expect(parseTotpUri("https://example.com/?secret=ABC")).toBeNull();
  });

  it("returns null for garbage", () => {
    expect(parseTotpUri("not a uri")).toBeNull();
  });
});

describe("groupKey", () => {
  it("groups a 32-character key into eight blocks", () => {
    expect(groupKey("A".repeat(32))).toBe(Array(8).fill("AAAA").join(" "));
  });

  it("leaves a short last block", () => {
    expect(groupKey("A".repeat(33))).toBe(
      `${Array(8).fill("AAAA").join(" ")} A`,
    );
  });
});

describe("normalizeTotpInput", () => {
  it.each(["123 456", "123-456", " 123456 "])("normalizes %j", (raw) => {
    expect(normalizeTotpInput(raw)).toBe("123456");
  });
});

describe("totpCodeSchema", () => {
  it.each(["12345", "abcdef", "1234567"])("rejects %j", (raw) => {
    expect(totpCodeSchema.safeParse(raw).success).toBe(false);
  });

  it("accepts six digits", () => {
    expect(totpCodeSchema.safeParse("123456").success).toBe(true);
  });
});

describe("verifyCodeSchema", () => {
  it("accepts a code typed with a space", () => {
    expect(verifyCodeSchema.safeParse({ code: "123 456" }).success).toBe(true);
  });

  it("rejects a short code", () => {
    expect(verifyCodeSchema.safeParse({ code: "12 34" }).success).toBe(false);
  });
});

describe("backupCodesFileText", () => {
  const text = backupCodesFileText(["aaaaa-bbbbb", "ccccc-ddddd"], {
    email: "a@husky.neu.edu",
    generatedAt: new Date("2026-10-29T12:00:00Z"),
  });

  it("names the account and the date", () => {
    expect(text).toContain("SGAuth backup codes for a@husky.neu.edu");
    expect(text).toContain("Generated 2026-10-29");
  });

  it("holds every code on its own line", () => {
    const lines = text.split("\n");
    expect(lines).toContain("aaaaa-bbbbb");
    expect(lines).toContain("ccccc-ddddd");
  });

  it("states that each code works once", () => {
    expect(text).toContain(
      "Each code works once. Keep this file somewhere safe.",
    );
  });
});

describe("searchParamsSchema and parseSecurityReason", () => {
  it("rejects an unknown reason", () => {
    expect(searchParamsSchema.safeParse({ reason: "other" }).success).toBe(
      false,
    );
    expect(parseSecurityReason({ reason: "other" })).toBeUndefined();
  });

  it("reads the known reason", () => {
    expect(parseSecurityReason({ reason: "mfa-required" })).toBe(
      "mfa-required",
    );
  });

  it("reads no reason", () => {
    expect(parseSecurityReason({})).toBeUndefined();
  });
});

describe("securityErrorCopy", () => {
  it.each([
    ["INVALID_PASSWORD", "password", "That password is incorrect."],
    ["PASSWORD_TOO_SHORT", "newPassword", "Use 12 to 128 characters."],
    ["PASSWORD_TOO_LONG", "newPassword", "Use 12 to 128 characters."],
    [
      "INVALID_CODE",
      "code",
      "That code didn't work. Check your authenticator app and try again.",
    ],
    [
      "TOO_MANY_ATTEMPTS_REQUEST_NEW_CODE",
      "code",
      "Too many incorrect codes. Wait 15 minutes and try again.",
    ],
    [
      "ACCOUNT_TEMPORARILY_LOCKED",
      "code",
      "Too many incorrect codes. Wait 15 minutes and try again.",
    ],
  ])("%s", (code, field, message) => {
    expect(securityErrorCopy(400, { code })).toEqual({ field, message });
  });

  it.each([
    ["TOTP_ALREADY_ENABLED", "Two-factor authentication is already on."],
    ["TWO_FACTOR_NOT_ENABLED", "Two-factor authentication is already off."],
    [
      "MFA_REQUIRED_FOR_ADMIN",
      "Two-factor authentication can't be turned off while you are an admin.",
    ],
  ])("%s asks for a refresh", (code, message) => {
    expect(securityErrorCopy(400, { code })).toEqual({
      message,
      refresh: true,
    });
  });

  it("says nothing for a cancelled re-auth", () => {
    expect(securityErrorCopy(403, { code: "REAUTH_REQUIRED" })).toBeNull();
  });

  it("falls back by status for an unknown code", () => {
    expect(securityErrorCopy(401, { code: "NOPE" })).toMatchObject({
      signedOut: true,
    });
    expect(securityErrorCopy(429, { code: "NOPE" })?.message).toBe(
      "Too many attempts. Wait a minute and try again.",
    );
    expect(securityErrorCopy(500, { code: "NOPE" })?.message).toBe(
      "Something went wrong. Try again.",
    );
  });

  it("falls back by status for a body without a code", () => {
    expect(securityErrorCopy(401, null)?.signedOut).toBe(true);
    expect(securityErrorCopy(502, "<html>")?.message).toBe(
      "Something went wrong. Try again.",
    );
  });

  it("does not read inherited keys as codes", () => {
    expect(securityErrorCopy(500, { code: "constructor" })?.message).toBe(
      "Something went wrong. Try again.",
    );
  });
});

describe("postSecurity", () => {
  function reply(status: number, body: unknown) {
    return vi.fn(async () => new Response(JSON.stringify(body), { status }));
  }

  it("returns the body of a success", async () => {
    const send = reply(200, { ok: 1 });
    const result = await postSecurity(send, "/p", { password: "x" });
    expect(result).toEqual({ ok: true, body: { ok: 1 } });
    expect(send).toHaveBeenCalledWith("/p", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ password: "x" }),
    });
  });

  it("maps an error response", async () => {
    const result = await postSecurity(
      reply(400, { code: "INVALID_PASSWORD" }),
      "/p",
      {},
    );
    expect(result).toMatchObject({
      ok: false,
      error: { field: "password" },
    });
  });

  it("returns a null error for a cancelled re-auth", async () => {
    const result = await postSecurity(
      reply(403, { code: "REAUTH_REQUIRED" }),
      "/p",
      {},
    );
    expect(result).toEqual({ ok: false, error: null });
  });

  it("returns the generic error when the request throws", async () => {
    const send = vi.fn(async () => {
      throw new Error("offline");
    });
    const result = await postSecurity(send, "/p", {});
    expect(result).toEqual({
      ok: false,
      error: { message: "Something went wrong. Try again." },
    });
  });
});

describe("response parsers", () => {
  it("reads the enable response", () => {
    expect(
      parseEnableResponse({ totpURI: "otpauth://x", backupCodes: ["a"] }),
    ).toEqual({ totpURI: "otpauth://x", backupCodes: ["a"] });
    expect(parseEnableResponse({ totpURI: "otpauth://x" })).toBeNull();
    expect(
      parseEnableResponse({ totpURI: "otpauth://x", backupCodes: [] }),
    ).toBeNull();
  });

  it("reads the regenerate response", () => {
    expect(parseRegenerateResponse({ backupCodes: ["a", "b"] })).toEqual([
      "a",
      "b",
    ]);
    expect(parseRegenerateResponse({ status: true })).toBeNull();
  });
});

describe("backupCodesStatus", () => {
  it("is null when the count is unknown", () => {
    expect(backupCodesStatus(null)).toBeNull();
  });

  it("has no warning above two", () => {
    expect(backupCodesStatus(8)).toEqual({
      summary: "Backup codes left: 8 of 10",
      warning: null,
    });
  });

  it("warns at two or fewer", () => {
    expect(backupCodesStatus(2)?.warning).toContain("running low");
  });

  it("warns that none are left", () => {
    expect(backupCodesStatus(0)?.warning).toContain("no backup codes left");
  });
});
