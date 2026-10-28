import { describe, expect, it } from "vitest";
import { POLICIES, matchAuthRoute } from "@/lib/rate-limit/policies";

describe("matchAuthRoute", () => {
  it.each([
    ["POST", "/sign-in/email", "signIn"],
    ["POST", "/two-factor/verify-totp", "signIn"],
    ["POST", "/two-factor/verify-backup-code", "signIn"],
    ["POST", "/sign-up/email", "signUp"],
    ["POST", "/request-password-reset", "passwordReset"],
    ["POST", "/send-verification-email", "verificationResend"],
    ["POST", "/token", "token"],
    ["GET", "/token", "token"],
  ])("%s %s is limited by %s", (method, path, policy) => {
    expect(matchAuthRoute(method, path)).toBe(policy);
  });

  it.each([
    ["GET", "/get-session"],
    ["POST", "/get-session"],
    ["GET", "/ok"],
    ["GET", "/sign-in/email"],
    ["GET", "/two-factor/verify-totp"],
    ["POST", "/two-factor/disable"],
    // Limited in its Better Auth hook, where the user id is known.
    ["POST", "/change-password"],
    ["POST", "/sign-in/email/extra"],
    ["POST", "/sign-out"],
    ["POST", "/"],
  ])("%s %s is not limited", (method, path) => {
    expect(matchAuthRoute(method, path)).toBeNull();
  });
});

describe("POLICIES", () => {
  it("encodes the limits from the ticket", () => {
    const flat = Object.values(POLICIES)
      .flat()
      .map((rule) => [rule.id, rule.limit, rule.windowSeconds, rule.by]);
    expect(flat).toEqual([
      ["sign-in:ip:1m", 10, 60, "ip"],
      ["sign-in:ip:1h", 50, 3600, "ip"],
      ["sign-up:ip:1h", 5, 3600, "ip"],
      ["reset:ip:10m", 3, 600, "ip"],
      ["reset:email:10m", 3, 600, "email"],
      ["verify:email:1h", 3, 3600, "email"],
      ["token:session:1m", 60, 60, "session"],
      ["session-lookup:session:1m", 120, 60, "session"],
      ["token-link:ip:10m", 20, 600, "ip"],
      ["reauth:user:1m", 5, 60, "user"],
      ["change-password:user:10m", 10, 600, "user"],
      ["admin:user:1m", 100, 60, "user"],
      ["admin-export:user:10m", 10, 600, "user"],
      ["set-password:ip:10m", 10, 600, "ip"],
      ["set-password:email:10m", 5, 600, "email"],
      ["set-password-link:user:1h", 3, 3600, "user"],
      ["invite:user:1d", 3, 86400, "user"],
    ]);
  });

  it("uses unique rule ids", () => {
    const ids = Object.values(POLICIES)
      .flat()
      .map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
