import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isAllowedSignupEmail,
  normalizeEmail,
  passwordSchema,
} from "@/lib/auth/policy";

describe("normalizeEmail", () => {
  it.each([
    ["x@northeastern.edu", "x@northeastern.edu"],
    ["  X@Northeastern.EDU  ", "x@northeastern.edu"],
    ["\tMixed.Case@Gmail.com\n", "mixed.case@gmail.com"],
  ])("normalizes %j", (raw, expected) => {
    expect(normalizeEmail(raw)).toBe(expected);
  });
});

describe("isAllowedSignupEmail", () => {
  it.each([
    ["allowed", "x@northeastern.edu", true],
    ["mixed case", "X@Northeastern.EDU", true],
    ["padded", "  x@northeastern.edu ", true],
    ["subdomain", "x@sub.northeastern.edu", false],
    ["lookalike suffix", "x@northeastern.edu.evil.com", false],
    ["lookalike prefix", "x@evilnortheastern.edu", false],
    ["trailing dot", "x@northeastern.edu.", false],
    ["legacy alias", "x@husky.neu.edu", false],
    ["other domain", "x@gmail.com", false],
    ["no @", "northeastern.edu", false],
    ["no local part", "@northeastern.edu", false],
    ["two @", "a@b@northeastern.edu", false],
    ["empty", "", false],
  ])("%s: %s", (_name, email, expected) => {
    expect(isAllowedSignupEmail(email)).toBe(expected);
  });
});

describe("passwordSchema", () => {
  it.each([
    [PASSWORD_MIN_LENGTH - 1, false],
    [PASSWORD_MIN_LENGTH, true],
    [PASSWORD_MAX_LENGTH, true],
    [PASSWORD_MAX_LENGTH + 1, false],
  ])("length %i -> %s", (length, ok) => {
    expect(passwordSchema.safeParse("a".repeat(length)).success).toBe(ok);
  });

  it("uses the ticket bounds", () => {
    expect(PASSWORD_MIN_LENGTH).toBe(12);
    expect(PASSWORD_MAX_LENGTH).toBe(128);
  });
});

describe("AUTH_ERROR_CODES", () => {
  it("keys each entry by its stable code", () => {
    for (const [key, value] of Object.entries(AUTH_ERROR_CODES)) {
      expect(value.code).toBe(key);
      expect(value.message).not.toBe("");
    }
  });
});
