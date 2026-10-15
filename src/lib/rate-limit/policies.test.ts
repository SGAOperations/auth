import { describe, expect, it } from "vitest";
import { POLICIES, matchAuthRoute } from "@/lib/rate-limit/policies";

describe("matchAuthRoute", () => {
  it.each([
    ["POST", "/sign-in/email", "signIn"],
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
      ["reauth:user:1m", 5, 60, "user"],
      ["admin:user:1m", 100, 60, "user"],
    ]);
  });

  it("uses unique rule ids", () => {
    const ids = Object.values(POLICIES)
      .flat()
      .map((rule) => rule.id);
    expect(new Set(ids).size).toBe(ids.length);
  });
});
