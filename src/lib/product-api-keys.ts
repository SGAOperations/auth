import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";

// Product API keys (#312): how a product's server proves which product it is
// when it calls SGAuth without a user's cookie. Pure apart from the Prisma
// client it is handed, so the parsing and the checks are unit-testable.
//
// A key is `sgak_<prefix>_<secret>`. The prefix is public: it is shown in the
// admin list and finds the row. Only the SHA-256 of the whole key is stored,
// and the key is shown once, when it is created.

const KEY_PATTERN = /^sgak_([a-z0-9]{12})_([A-Za-z0-9_-]{43})$/;
const BEARER_PREFIX = "Bearer ";

/** How stale `lastUsedAt` may get before a request stamps it again. */
export const LAST_USED_RESOLUTION_MS = 5 * 60 * 1000;

/** Lower-case hex SHA-256: the only form of a key that is ever stored. */
export function hashProductApiKey(key: string): string {
  return createHash("sha256").update(key).digest("hex");
}

/** A fresh key. The caller stores `prefix` and `keyHash` and shows `key` once. */
export function generateProductApiKey(): {
  key: string;
  prefix: string;
  keyHash: string;
} {
  // 12 base-36 characters from 9 random bytes, so the prefix is unique in
  // practice; the unique index catches the rest.
  const prefix = BigInt(`0x${randomBytes(9).toString("hex")}`)
    .toString(36)
    .padStart(12, "0")
    .slice(-12);
  const key = `sgak_${prefix}_${randomBytes(32).toString("base64url")}`;
  return { key, prefix, keyHash: hashProductApiKey(key) };
}

/** The prefix of a well-formed bearer key, or null. */
export function parseProductApiKey(
  header: string | null,
): { key: string; prefix: string } | null {
  if (!header?.startsWith(BEARER_PREFIX)) return null;
  const key = header.slice(BEARER_PREFIX.length).trim();
  const match = KEY_PATTERN.exec(key);
  return match ? { key, prefix: match[1] } : null;
}

export interface AuthenticatedProduct {
  productId: string;
  slug: string;
  keyId: string;
}

type ProductApiKeyDb = Pick<PrismaClient, "productApiKey">;

/**
 * The product a request's bearer key belongs to, or null. Null for a missing or
 * malformed header, an unknown prefix, a wrong secret, a revoked key and an
 * inactive product alike, so a caller cannot tell them apart. The hashes are
 * compared in constant time.
 */
export async function authenticateProductKey(
  db: ProductApiKeyDb,
  header: string | null,
  now: Date = new Date(),
): Promise<AuthenticatedProduct | null> {
  const parsed = parseProductApiKey(header);
  if (!parsed) return null;

  const row = await db.productApiKey.findUnique({
    where: { prefix: parsed.prefix },
    select: {
      id: true,
      keyHash: true,
      revokedAt: true,
      lastUsedAt: true,
      product: { select: { id: true, slug: true, isActive: true } },
    },
  });
  if (!row) return null;

  const presented = Buffer.from(hashProductApiKey(parsed.key), "hex");
  const stored = Buffer.from(row.keyHash, "hex");
  if (stored.length !== presented.length) return null;
  if (!timingSafeEqual(presented, stored)) return null;
  if (row.revokedAt || !row.product.isActive) return null;

  // At most one write per key per few minutes: the lookup is a hot path.
  const staleBefore = new Date(now.getTime() - LAST_USED_RESOLUTION_MS);
  if (!row.lastUsedAt || row.lastUsedAt < staleBefore) {
    await db.productApiKey.updateMany({
      where: {
        id: row.id,
        OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: staleBefore } }],
      },
      data: { lastUsedAt: now },
    });
  }

  return { productId: row.product.id, slug: row.product.slug, keyId: row.id };
}

/** The most live keys one product may hold: enough to rotate, no more. */
export const MAX_ACTIVE_KEYS_PER_PRODUCT = 3;

export const productApiKeyNameSchema = z
  .string()
  .trim()
  .min(1, "Name the key, for example after the environment that uses it.")
  .max(60, "60 characters or fewer.");

export interface ProductApiKeyListItem {
  id: string;
  name: string;
  prefix: string;
  createdAt: Date;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

/** A product's keys for the admin page, newest first. Never the hash. */
export function listProductApiKeys(
  db: ProductApiKeyDb,
  productId: string,
): Promise<ProductApiKeyListItem[]> {
  return db.productApiKey.findMany({
    where: { productId },
    select: {
      id: true,
      name: true,
      prefix: true,
      createdAt: true,
      lastUsedAt: true,
      revokedAt: true,
    },
    orderBy: { createdAt: "desc" },
  });
}

export type CreateProductApiKeyResult =
  | { ok: true; id: string; key: string; prefix: string }
  | { ok: false; code: "TOO_MANY_KEYS" };

/** Stores a new key's hash and returns the key, which is never readable again. */
export async function createProductApiKey(
  db: ProductApiKeyDb,
  input: { productId: string; name: string; createdById: string },
): Promise<CreateProductApiKeyResult> {
  const live = await db.productApiKey.count({
    where: { productId: input.productId, revokedAt: null },
  });
  if (live >= MAX_ACTIVE_KEYS_PER_PRODUCT) {
    return { ok: false, code: "TOO_MANY_KEYS" };
  }
  const { key, prefix, keyHash } = generateProductApiKey();
  const row = await db.productApiKey.create({
    data: { ...input, prefix, keyHash },
    select: { id: true },
  });
  return { ok: true, id: row.id, key, prefix };
}

/** Revokes a live key of this product. Null when there is none to revoke. */
export async function revokeProductApiKey(
  db: ProductApiKeyDb,
  input: { productId: string; keyId: string },
  now: Date = new Date(),
): Promise<{ id: string; prefix: string } | null> {
  const row = await db.productApiKey.findFirst({
    where: { id: input.keyId, productId: input.productId, revokedAt: null },
    select: { id: true, prefix: true },
  });
  if (!row) return null;
  const { count } = await db.productApiKey.updateMany({
    where: { id: row.id, revokedAt: null },
    data: { revokedAt: now },
  });
  return count === 1 ? row : null;
}
