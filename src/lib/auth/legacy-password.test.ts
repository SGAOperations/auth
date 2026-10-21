import { describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { hashPassword } from "better-auth/crypto";
import {
  LEGACY_BCRYPT_PREFIX,
  isLegacyBcryptHash,
  verifyPassword,
} from "@/lib/auth/legacy-password";

const PW = "chambers-password-1";

function legacy(version: "a" | "b" | "y") {
  const hash = bcrypt.hashSync(PW, 4).replace(/^\$2[aby]\$/, `$2${version}$`);
  return LEGACY_BCRYPT_PREFIX + hash;
}

describe("verifyPassword", () => {
  it("verifies a scrypt hash", async () => {
    const hash = await hashPassword(PW);
    expect(await verifyPassword({ hash, password: PW })).toBe(true);
    expect(await verifyPassword({ hash, password: "wrong" })).toBe(false);
  });

  it.each(["a", "b", "y"] as const)(
    "verifies a marked $2%s$ bcrypt hash",
    async (version) => {
      const hash = legacy(version);
      expect(await verifyPassword({ hash, password: PW })).toBe(true);
      expect(await verifyPassword({ hash, password: "wrong" })).toBe(false);
    },
  );

  it("never accepts a bare bcrypt hash with no marker", async () => {
    // Routed to the default scrypt verify, which rejects a hash it cannot parse.
    const hash = bcrypt.hashSync(PW, 4);
    await expect(verifyPassword({ hash, password: PW })).rejects.toThrow();
  });

  it.each([
    ["garbage", "bcrypt$garbage"],
    ["empty", "bcrypt$"],
    ["truncated", legacy("a").slice(0, -1)],
  ])("fails closed on a %s hash without throwing", async (_name, hash) => {
    await expect(verifyPassword({ hash, password: PW })).resolves.toBe(false);
  });
});

describe("isLegacyBcryptHash", () => {
  it("detects only the marker", async () => {
    expect(isLegacyBcryptHash(null)).toBe(false);
    expect(isLegacyBcryptHash(undefined)).toBe(false);
    expect(isLegacyBcryptHash("")).toBe(false);
    expect(isLegacyBcryptHash(await hashPassword(PW))).toBe(false);
    expect(isLegacyBcryptHash(legacy("a"))).toBe(true);
  });
});
