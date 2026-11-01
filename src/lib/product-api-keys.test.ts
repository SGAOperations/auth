import { describe, expect, it, vi } from "vitest";
import {
  LAST_USED_RESOLUTION_MS,
  authenticateProductKey,
  generateProductToken,
  hashProductToken,
  parseProductToken,
} from "@/lib/product-api-keys";

const NOW = new Date("2026-11-01T12:00:00Z");

function fakeDb(row: unknown) {
  const updateMany = vi.fn(async () => ({ count: 1 }));
  const findUnique = vi.fn(async () => row);
  return {
    db: { productApiKey: { findUnique, updateMany } } as never,
    findUnique,
    updateMany,
  };
}

function rowFor(
  key: string,
  overrides: Partial<{
    revokedAt: Date | null;
    lastUsedAt: Date | null;
    isActive: boolean;
  }> = {},
) {
  return {
    id: "0192f0a0-0000-7000-8000-00000000000a",
    keyHash: hashProductToken(key),
    revokedAt: overrides.revokedAt ?? null,
    lastUsedAt: overrides.lastUsedAt ?? null,
    product: {
      id: "0192f0a0-0000-7000-8000-00000000000b",
      slug: "chambers",
      isActive: overrides.isActive ?? true,
    },
  };
}

describe("generateProductToken", () => {
  it("makes a key that its own prefix and hash describe", () => {
    const { token: key, prefix, tokenHash: keyHash } = generateProductToken();
    expect(key).toMatch(/^sgak_[a-z0-9]{12}_[A-Za-z0-9_-]{43}$/);
    expect(key.startsWith(`sgak_${prefix}_`)).toBe(true);
    expect(keyHash).toBe(hashProductToken(key));
    expect(keyHash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("never repeats a prefix", () => {
    const prefixes = new Set(
      Array.from({ length: 50 }, () => generateProductToken().prefix),
    );
    expect(prefixes.size).toBe(50);
  });
});

describe("parseProductToken", () => {
  const { token: key, prefix } = generateProductToken();

  it("reads a bearer key", () => {
    expect(parseProductToken(`Bearer ${key}`)).toEqual({ token: key, prefix });
  });

  it.each([
    null,
    "",
    key,
    `Basic ${key}`,
    "Bearer sgak_short_x",
    `Bearer ${key}x`,
    `Bearer ${key.replace("sgak_", "sgk_")}`,
  ])("refuses %s", (header) => {
    expect(parseProductToken(header)).toBeNull();
  });
});

describe("authenticateProductKey", () => {
  const { token: key } = generateProductToken();

  it("names the product of a live key and stamps its first use", async () => {
    const { db, updateMany } = fakeDb(rowFor(key));
    await expect(
      authenticateProductKey(db, `Bearer ${key}`, NOW),
    ).resolves.toEqual({
      productId: "0192f0a0-0000-7000-8000-00000000000b",
      slug: "chambers",
      keyId: "0192f0a0-0000-7000-8000-00000000000a",
    });
    expect(updateMany).toHaveBeenCalledOnce();
  });

  it("does not stamp a key used a moment ago", async () => {
    const recent = new Date(NOW.getTime() - LAST_USED_RESOLUTION_MS / 2);
    const { db, updateMany } = fakeDb(rowFor(key, { lastUsedAt: recent }));
    await authenticateProductKey(db, `Bearer ${key}`, NOW);
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a malformed header without a lookup", async () => {
    const { db, findUnique } = fakeDb(rowFor(key));
    await expect(
      authenticateProductKey(db, "Bearer nope", NOW),
    ).resolves.toBeNull();
    expect(findUnique).not.toHaveBeenCalled();
  });

  it("refuses an unknown prefix", async () => {
    const { db } = fakeDb(null);
    await expect(
      authenticateProductKey(db, `Bearer ${key}`, NOW),
    ).resolves.toBeNull();
  });

  it("refuses the right prefix with the wrong secret", async () => {
    const other = `${key.slice(0, -4)}AAAA`;
    const { db, updateMany } = fakeDb(rowFor(key));
    await expect(
      authenticateProductKey(db, `Bearer ${other}`, NOW),
    ).resolves.toBeNull();
    expect(updateMany).not.toHaveBeenCalled();
  });

  it("refuses a revoked key", async () => {
    const { db } = fakeDb(rowFor(key, { revokedAt: NOW }));
    await expect(
      authenticateProductKey(db, `Bearer ${key}`, NOW),
    ).resolves.toBeNull();
  });

  it("refuses the key of an inactive product", async () => {
    const { db } = fakeDb(rowFor(key, { isActive: false }));
    await expect(
      authenticateProductKey(db, `Bearer ${key}`, NOW),
    ).resolves.toBeNull();
  });
});
