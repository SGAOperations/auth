import { describe, expect, it } from "vitest";
import {
  MAX_PASSKEYS_PER_USER,
  PASSKEY_ERROR_CODES,
  PASSKEY_NAME_MAX_LENGTH,
  hasUserVerification,
  passkeyNameSchema,
} from "@/lib/auth/passkey-policy";

function authenticatorData(length: number, flags: number): string {
  const bytes = new Uint8Array(length);
  if (length > 32) bytes[32] = flags;
  return Buffer.from(bytes).toString("base64url");
}

describe("passkey limits", () => {
  it("allows ten passkeys and 64-character names", () => {
    expect(MAX_PASSKEYS_PER_USER).toBe(10);
    expect(PASSKEY_NAME_MAX_LENGTH).toBe(64);
  });
});

describe("passkeyNameSchema", () => {
  it("treats a missing or empty name as none", () => {
    expect(passkeyNameSchema.parse(undefined)).toBeUndefined();
    expect(passkeyNameSchema.parse("")).toBeUndefined();
  });

  it("treats a whitespace-only name as none", () => {
    expect(passkeyNameSchema.parse("   \t ")).toBeUndefined();
  });

  it("accepts one character and 64 characters", () => {
    expect(passkeyNameSchema.parse("a")).toBe("a");
    expect(passkeyNameSchema.parse("a".repeat(64))).toBe("a".repeat(64));
  });

  it("rejects 65 characters", () => {
    expect(passkeyNameSchema.safeParse("a".repeat(65)).success).toBe(false);
  });

  it("trims before measuring and returns the trimmed name", () => {
    expect(passkeyNameSchema.parse("  MacBook  ")).toBe("MacBook");
    expect(passkeyNameSchema.parse(` ${"a".repeat(64)} `)).toBe("a".repeat(64));
  });

  it("rejects a value that is not a string", () => {
    expect(passkeyNameSchema.safeParse(5).success).toBe(false);
  });
});

describe("hasUserVerification", () => {
  it("is true when both user presence and user verification are set", () => {
    expect(hasUserVerification(authenticatorData(37, 0x05))).toBe(true);
  });

  it("is false when only user presence is set", () => {
    expect(hasUserVerification(authenticatorData(37, 0x01))).toBe(false);
  });

  it("is true when user verification is set without other flags", () => {
    expect(hasUserVerification(authenticatorData(37, 0x04))).toBe(true);
  });

  it("is false when the data is shorter than 37 bytes", () => {
    expect(hasUserVerification(authenticatorData(36, 0x05))).toBe(false);
    expect(hasUserVerification("")).toBe(false);
  });

  it("is false for input that is not base64url", () => {
    expect(hasUserVerification("not base64url!")).toBe(false);
    expect(hasUserVerification("AAAA+AAA/AAA=")).toBe(false);
  });

  it("reads the flags byte of longer data", () => {
    expect(hasUserVerification(authenticatorData(120, 0x45))).toBe(true);
    expect(hasUserVerification(authenticatorData(120, 0x41))).toBe(false);
  });
});

describe("PASSKEY_ERROR_CODES", () => {
  it("carries a code and a message for each rule", () => {
    for (const entry of Object.values(PASSKEY_ERROR_CODES)) {
      expect(entry.message.length).toBeGreaterThan(0);
    }
    expect(PASSKEY_ERROR_CODES.PASSKEY_LIMIT_REACHED.code).toBe(
      "PASSKEY_LIMIT_REACHED",
    );
  });
});
