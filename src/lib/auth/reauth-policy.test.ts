import { describe, expect, it } from "vitest";
import {
  FRESH_AUTH_AUTH_PATHS,
  REAUTH_WINDOW_MS,
  classifySecondFactor,
  isFresh,
  reauthBodySchema,
} from "@/lib/auth/reauth-policy";

const NOW = new Date("2026-01-01T12:00:00Z");
const ago = (ms: number) => new Date(NOW.getTime() - ms);

describe("isFresh", () => {
  it("is false when the session never re-authenticated", () => {
    expect(isFresh(null, NOW)).toBe(false);
  });

  it.each([
    ["0 s", 0],
    ["9 m 59 s", 9 * 60_000 + 59_000],
    ["exactly 10 m", REAUTH_WINDOW_MS],
  ])("is true at %s", (_label, age) => {
    expect(isFresh(ago(age), NOW)).toBe(true);
  });

  it.each([
    ["10 m + 1 ms", REAUTH_WINDOW_MS + 1],
    ["11 m", 11 * 60_000],
  ])("is false at %s", (_label, age) => {
    expect(isFresh(ago(age), NOW)).toBe(false);
  });

  it("is false for a stamp in the future", () => {
    expect(isFresh(new Date(NOW.getTime() + 1000), NOW)).toBe(false);
  });
});

describe("reauthBodySchema", () => {
  it("accepts a password alone and a password with a code", () => {
    expect(reauthBodySchema.safeParse({ password: "pw" }).success).toBe(true);
    expect(
      reauthBodySchema.safeParse({ password: "pw", code: "123456" }).success,
    ).toBe(true);
  });

  it("rejects an empty password", () => {
    expect(reauthBodySchema.safeParse({ password: "" }).success).toBe(false);
  });

  it("rejects a 129-character password and accepts 128", () => {
    expect(
      reauthBodySchema.safeParse({ password: "a".repeat(129) }).success,
    ).toBe(false);
    expect(
      reauthBodySchema.safeParse({ password: "a".repeat(128) }).success,
    ).toBe(true);
  });

  it("rejects unknown keys", () => {
    expect(
      reauthBodySchema.safeParse({ password: "pw", extra: true }).success,
    ).toBe(false);
  });

  it("trims the code and rejects a blank or oversized one", () => {
    expect(
      reauthBodySchema.parse({ password: "pw", code: " 123456 " }),
    ).toEqual({ password: "pw", code: "123456" });
    expect(
      reauthBodySchema.safeParse({ password: "pw", code: "   " }).success,
    ).toBe(false);
    expect(
      reauthBodySchema.safeParse({ password: "pw", code: "1".repeat(33) })
        .success,
    ).toBe(false);
  });
});

describe("classifySecondFactor", () => {
  it.each([
    ["123456", "totp"],
    ["abcde-12345", "backup_code"],
    ["12345", "backup_code"],
    ["1234567", "backup_code"],
    ["12345a", "backup_code"],
  ])("classifies %s as %s", (code, expected) => {
    expect(classifySecondFactor(code)).toBe(expected);
  });
});

describe("FRESH_AUTH_AUTH_PATHS", () => {
  it("has no duplicate and only absolute paths", () => {
    expect(new Set(FRESH_AUTH_AUTH_PATHS).size).toBe(
      FRESH_AUTH_AUTH_PATHS.length,
    );
    for (const path of FRESH_AUTH_AUTH_PATHS) expect(path).toMatch(/^\//);
  });
});
