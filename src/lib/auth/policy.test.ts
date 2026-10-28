import { describe, expect, it } from "vitest";
import {
  AUTH_ERROR_CODES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  changePasswordFormSchema,
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

describe("changePasswordFormSchema", () => {
  const valid = {
    currentPassword: "the-current-password",
    newPassword: "a-brand-new-password",
    confirmPassword: "a-brand-new-password",
  };

  function failedPaths(input: unknown) {
    const result = changePasswordFormSchema.safeParse(input);
    return result.success
      ? []
      : result.error.issues.map((issue) => issue.path.join("."));
  }

  it("accepts a valid triple", () => {
    expect(changePasswordFormSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects a mismatch on confirmPassword", () => {
    expect(
      failedPaths({ ...valid, confirmPassword: "something-else-12" }),
    ).toEqual(["confirmPassword"]);
  });

  it("rejects a new password equal to the current one on newPassword", () => {
    const same = "the-same-password-1";
    expect(
      failedPaths({
        currentPassword: same,
        newPassword: same,
        confirmPassword: same,
      }),
    ).toEqual(["newPassword"]);
  });

  it.each([PASSWORD_MIN_LENGTH - 1, PASSWORD_MAX_LENGTH + 1])(
    "rejects a new password of %i characters",
    (length) => {
      const newPassword = "a".repeat(length);
      expect(
        failedPaths({ ...valid, newPassword, confirmPassword: newPassword }),
      ).toContain("newPassword");
    },
  );

  it("rejects an empty current password", () => {
    expect(failedPaths({ ...valid, currentPassword: "" })).toEqual([
      "currentPassword",
    ]);
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
