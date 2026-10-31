"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, withAuditTransaction } from "@/lib/audit";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import * as service from "@/lib/product-admin";
import {
  createProductApiKey as createKey,
  productApiKeyNameSchema,
  revokeProductApiKey as revokeKey,
} from "@/lib/product-api-keys";
import { invalidateProductCache } from "@/lib/products";
import { limitRequest } from "@/lib/rate-limit/server";

const LIST_PATH = "/admin/products";

export type ProductActionFailure =
  | {
      ok: false;
      code:
        | "FORBIDDEN"
        | "RATE_LIMITED"
        | "NOT_FOUND"
        | "SLUG_TAKEN"
        | "ACTIVE_PRODUCT"
        | "CONFIRMATION_MISMATCH";
    }
  | {
      ok: false;
      code: "INVALID_INPUT";
      fieldErrors: Record<string, string[]>;
    };

export type ProductActionResult =
  | { ok: true; id?: string; unchanged?: true }
  | ProductActionFailure;

const idSchema = z.uuid();
const confirmSlugSchema = z.string().max(64);

// The shared ladder: session, `can()`, admin MFA, then the rate limit. A denial
// returns before any rate-limit token is spent or any row is touched. Server
// actions get Next.js's Origin-vs-Host check; none sets `allowedOrigins`.
async function authorizeProductAdmin(): Promise<
  { actor: CurrentUser } | { failure: ProductActionFailure }
> {
  const actor = await getCurrentUser();
  if (
    !actor ||
    !can(actor, "manageProducts").allowed ||
    !actor.twoFactorEnabled
  ) {
    return { failure: { ok: false, code: "FORBIDDEN" } };
  }
  const limited = await limitRequest("adminMutation", actor.id);
  if (limited) return { failure: { ok: false, code: "RATE_LIMITED" } };
  return { actor };
}

function toFailure(err: unknown): ProductActionFailure {
  if (!(err instanceof service.ProductError)) throw err;
  if (err.code === "INVALID_INPUT") {
    return { ok: false, code: err.code, fieldErrors: err.fieldErrors };
  }
  return { ok: false, code: err.code };
}

async function attempt(
  run: () => Promise<ProductActionResult>,
): Promise<ProductActionResult> {
  try {
    return await run();
  } catch (err) {
    return toFailure(err);
  }
}

function invalidate() {
  invalidateProductCache();
  revalidatePath(LIST_PATH);
}

export async function createProduct(
  values: unknown,
): Promise<ProductActionResult> {
  const authorized = await authorizeProductAdmin();
  if ("failure" in authorized) return authorized.failure;
  const { actor } = authorized;

  return attempt(async () => {
    const product = await withAuditTransaction(prisma, async (tx) => {
      const created = await service.createProduct(values, actor.id, {
        db: tx,
      });
      await audit({
        type: "PRODUCT_CREATED",
        actorType: "USER",
        actorUserId: actor.id,
        targetType: "PRODUCT",
        targetId: created.id,
        metadata: { slug: created.slug },
      });
      return created;
    });
    invalidate();
    return { ok: true, id: product.id };
  });
}

export async function updateProduct(
  id: unknown,
  values: unknown,
): Promise<ProductActionResult> {
  const authorized = await authorizeProductAdmin();
  if ("failure" in authorized) return authorized.failure;
  const { actor } = authorized;

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, code: "NOT_FOUND" };

  return attempt(async () => {
    const { product, changed } = await withAuditTransaction(
      prisma,
      async (tx) => {
        const result = await service.updateProduct(parsedId.data, values, {
          db: tx,
        });
        if (result.changed.length > 0) {
          await audit({
            type: "PRODUCT_UPDATED",
            actorType: "USER",
            actorUserId: actor.id,
            targetType: "PRODUCT",
            targetId: result.product.id,
            metadata: { slug: result.product.slug, fields: result.changed },
          });
        }
        return result;
      },
    );
    if (changed.length === 0) return { ok: true, unchanged: true };
    invalidate();
    return { ok: true, id: product.id };
  });
}

export async function deleteProduct(
  id: unknown,
  confirmSlug: unknown,
): Promise<ProductActionResult> {
  const authorized = await authorizeProductAdmin();
  if ("failure" in authorized) return authorized.failure;
  const { actor } = authorized;

  const parsedId = idSchema.safeParse(id);
  if (!parsedId.success) return { ok: false, code: "NOT_FOUND" };
  const parsedSlug = confirmSlugSchema.safeParse(confirmSlug);
  if (!parsedSlug.success) return { ok: false, code: "CONFIRMATION_MISMATCH" };

  const result = await attempt(async () => {
    await withAuditTransaction(prisma, async (tx) => {
      const deleted = await service.deleteProduct(
        parsedId.data,
        parsedSlug.data,
        { db: tx },
      );
      await audit({
        type: "PRODUCT_DELETED",
        actorType: "USER",
        actorUserId: actor.id,
        targetType: "PRODUCT",
        targetId: deleted.id,
        metadata: { slug: deleted.slug },
      });
    });
    invalidateProductCache();
    return { ok: true };
  });
  if (!result.ok) return result;
  // Outside the try: redirect() works by throwing.
  redirect(LIST_PATH);
}

export type ProductApiKeyActionResult =
  | { ok: true; key?: string }
  | { ok: false; code: "TOO_MANY_KEYS" | "INVALID_NAME"; message?: string }
  | ProductActionFailure;

/**
 * Creates a product API key (#312). The key is in the result once and is never
 * readable again: only its hash is stored, and the audit row holds the prefix.
 */
export async function createProductApiKey(
  productId: unknown,
  name: unknown,
): Promise<ProductApiKeyActionResult> {
  const authorized = await authorizeProductAdmin();
  if ("failure" in authorized) return authorized.failure;
  const { actor } = authorized;

  const parsedId = idSchema.safeParse(productId);
  if (!parsedId.success) return { ok: false, code: "NOT_FOUND" };
  const parsedName = productApiKeyNameSchema.safeParse(name);
  if (!parsedName.success) {
    return {
      ok: false,
      code: "INVALID_NAME",
      message: parsedName.error.issues[0]?.message,
    };
  }

  const result = await withAuditTransaction(prisma, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: parsedId.data },
      select: { id: true, slug: true },
    });
    if (!product) return { ok: false, code: "NOT_FOUND" } as const;
    const created = await createKey(tx, {
      productId: product.id,
      name: parsedName.data,
      createdById: actor.id,
    });
    if (!created.ok) return created;
    await audit({
      type: "PRODUCT_API_KEY_CREATED",
      actorType: "USER",
      actorUserId: actor.id,
      targetType: "PRODUCT",
      targetId: product.id,
      metadata: {
        slug: product.slug,
        keyId: created.id,
        prefix: created.prefix,
      },
    });
    return { ok: true, key: created.key } as const;
  });
  if (result.ok) revalidatePath(`${LIST_PATH}/${parsedId.data}`);
  return result;
}

/** Revokes a product API key. Takes effect on the product's next request. */
export async function revokeProductApiKey(
  productId: unknown,
  keyId: unknown,
): Promise<ProductApiKeyActionResult> {
  const authorized = await authorizeProductAdmin();
  if ("failure" in authorized) return authorized.failure;
  const { actor } = authorized;

  const parsedProduct = idSchema.safeParse(productId);
  const parsedKey = idSchema.safeParse(keyId);
  if (!parsedProduct.success || !parsedKey.success) {
    return { ok: false, code: "NOT_FOUND" };
  }

  const result = await withAuditTransaction(prisma, async (tx) => {
    const product = await tx.product.findUnique({
      where: { id: parsedProduct.data },
      select: { id: true, slug: true },
    });
    if (!product) return { ok: false, code: "NOT_FOUND" } as const;
    const revoked = await revokeKey(tx, {
      productId: product.id,
      keyId: parsedKey.data,
    });
    if (!revoked) return { ok: false, code: "NOT_FOUND" } as const;
    await audit({
      type: "PRODUCT_API_KEY_REVOKED",
      actorType: "USER",
      actorUserId: actor.id,
      targetType: "PRODUCT",
      targetId: product.id,
      metadata: {
        slug: product.slug,
        keyId: revoked.id,
        prefix: revoked.prefix,
      },
    });
    return { ok: true } as const;
  });
  if (result.ok) revalidatePath(`${LIST_PATH}/${parsedProduct.data}`);
  return result;
}
