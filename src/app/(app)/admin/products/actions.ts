"use server";

import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { z } from "zod";
import { audit, withAuditTransaction } from "@/lib/audit";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import { can } from "@/lib/authz";
import { prisma } from "@/lib/prisma";
import * as service from "@/lib/product-admin";
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
