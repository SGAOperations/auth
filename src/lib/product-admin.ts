import "server-only";
import { z } from "zod";
import {
  Prisma,
  type PrismaClient,
  type Product,
  type ProductVisibility as PrismaProductVisibility,
} from "@/generated/prisma/client";
import type { ProductAuditField } from "@/lib/audit-catalog";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import {
  productCreateSchema,
  productUpdateSchema,
  type ProductUpdateInput,
} from "@/lib/product-input";
import type { ProductVisibility } from "@/lib/product-visibility";

export type ProductErrorCode =
  | "INVALID_INPUT"
  | "SLUG_TAKEN"
  | "NOT_FOUND"
  | "ACTIVE_PRODUCT"
  | "CONFIRMATION_MISMATCH";

export class ProductError extends Error {
  readonly code: ProductErrorCode;
  readonly fieldErrors: Record<string, string[]>;

  constructor(
    code: ProductErrorCode,
    message?: string,
    fieldErrors: Record<string, string[]> = {},
  ) {
    super(message ?? code);
    this.name = "ProductError";
    this.code = code;
    this.fieldErrors = fieldErrors;
  }
}

type Db = Prisma.TransactionClient | PrismaClient;

const SLUG_INDEX = "Product_slug_key";
const MAX_CAUSE_DEPTH = 3;

function collectMessages(err: unknown): string {
  const messages: string[] = [];
  let current: unknown = err;
  for (let depth = 0; depth < MAX_CAUSE_DEPTH; depth++) {
    if (!(current instanceof Error)) break;
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}

// The driver adapter reports the violated index at
// meta.driverAdapterError.cause.constraint.index; P2002 carries no meta.target.
function driverConstraintIndex(err: Prisma.PrismaClientKnownRequestError) {
  const adapterError: unknown = err.meta?.driverAdapterError;
  if (typeof adapterError !== "object" || adapterError === null) return null;
  const cause: unknown = (adapterError as { cause?: unknown }).cause;
  if (typeof cause !== "object" || cause === null) return null;
  const constraint: unknown = (cause as { constraint?: unknown }).constraint;
  if (typeof constraint !== "object" || constraint === null) return null;
  const index: unknown = (constraint as { index?: unknown }).index;
  return typeof index === "string" ? index : null;
}

const BACKSTOP_RE = /Product_\w+_check|product_slug_immutable/;

/**
 * Translates database failures into `ProductError`. Returns null for anything
 * else, which the caller rethrows as unexpected. A CHECK or trigger hit means
 * zod and SQL have drifted apart, so it is logged at `error`.
 */
export function toProductError(err: unknown): ProductError | null {
  if (err instanceof ProductError) return err;

  const message = collectMessages(err);

  if (
    err instanceof Prisma.PrismaClientKnownRequestError &&
    err.code === "P2002" &&
    driverConstraintIndex(err) === SLUG_INDEX
  ) {
    return new ProductError("SLUG_TAKEN", "Product slug is in use");
  }
  if (message.includes(SLUG_INDEX)) {
    return new ProductError("SLUG_TAKEN", "Product slug is in use");
  }
  if (err instanceof Prisma.PrismaClientKnownRequestError) {
    if (err.code === "P2025") {
      return new ProductError("NOT_FOUND", "Product not found");
    }
  }
  const backstop = BACKSTOP_RE.exec(message);
  if (backstop) {
    logger.error("product_write_hit_database_backstop", {
      constraint: backstop[0],
    });
    return new ProductError("INVALID_INPUT", "Product input is invalid");
  }
  return null;
}

function invalidInput(error: z.ZodError): ProductError {
  return new ProductError(
    "INVALID_INPUT",
    "Product input is invalid",
    z.flattenError(error).fieldErrors as Record<string, string[]>,
  );
}

async function inTransaction<T>(
  db: Db,
  run: (tx: Prisma.TransactionClient) => Promise<T>,
): Promise<T> {
  try {
    return "$transaction" in db ? await db.$transaction(run) : await run(db);
  } catch (err) {
    throw toProductError(err) ?? err;
  }
}

export function listProductsForAdmin({
  db = prisma,
}: { db?: Db } = {}): Promise<Product[]> {
  return db.product.findMany({
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
  });
}

export function getProductForAdmin(
  id: string,
  { db = prisma }: { db?: Db } = {},
): Promise<Product | null> {
  return db.product.findUnique({ where: { id } });
}

/**
 * Compile-time proof that the pure `PRODUCT_VISIBILITIES` tuple and the
 * generated Prisma enum list the same values, in both directions. The type
 * resolves to `never` when they drift, so assigning `true` to it in the const
 * below fails the type check.
 */
type ProductVisibilitiesMatchPrisma = [ProductVisibility] extends [
  PrismaProductVisibility,
]
  ? [PrismaProductVisibility] extends [ProductVisibility]
    ? true
    : never
  : never;

export const productVisibilitiesMatchPrisma: ProductVisibilitiesMatchPrisma = true;

export interface PositionOption {
  key: string;
  name: string;
  category: string | null;
  isLeadership: boolean;
}

export function listPositionOptions({ db = prisma }: { db?: Db } = {}): Promise<
  PositionOption[]
> {
  return db.position.findMany({
    where: { deletedAt: null },
    select: { key: true, name: true, category: true, isLeadership: true },
    orderBy: [{ category: { sort: "asc", nulls: "last" } }, { name: "asc" }],
  });
}

function sameSet(a: readonly string[], b: readonly string[]): boolean {
  const left = [...new Set(a)].sort();
  const right = [...new Set(b)].sort();
  return left.length === right.length && left.every((v, i) => v === right[i]);
}

type ProductEditable = Pick<
  Product,
  | "name"
  | "description"
  | "baseUrl"
  | "iconUrl"
  | "isActive"
  | "sortOrder"
  | "visibility"
  | "visibleToPositionKeys"
  | "loginRedirectPath"
>;

/**
 * The fields of `patch` that differ from `before`. Keys absent from the patch
 * are ignored, and position keys compare as sets.
 */
export function changedProductFields(
  before: ProductEditable,
  patch: ProductUpdateInput,
): ProductAuditField[] {
  const changed: ProductAuditField[] = [];
  const scalars = [
    "name",
    "description",
    "baseUrl",
    "iconUrl",
    "isActive",
    "sortOrder",
    "visibility",
    "loginRedirectPath",
  ] as const;
  for (const field of scalars) {
    const next = patch[field];
    if (next !== undefined && next !== before[field]) changed.push(field);
  }
  const keys = patch.visibleToPositionKeys;
  if (keys !== undefined && !sameSet(keys, before.visibleToPositionKeys)) {
    changed.push("visibleToPositionKeys");
  }
  return changed;
}

/**
 * Creates a product. Does not check authorization and writes no audit row;
 * the calling action owns both.
 */
export async function createProduct(
  input: unknown,
  actorId: string,
  { db = prisma }: { db?: Db } = {},
): Promise<Product> {
  const parsed = productCreateSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);
  try {
    return await db.product.create({
      data: { ...parsed.data, createdById: actorId },
    });
  } catch (err) {
    throw toProductError(err) ?? err;
  }
}

/**
 * Updates a product. A body that carries `slug` fails parsing: slugs are
 * permanent. When nothing changed, nothing is written and `changed` is empty.
 */
export async function updateProduct(
  id: string,
  input: unknown,
  { db = prisma }: { db?: Db } = {},
): Promise<{ product: Product; changed: ProductAuditField[] }> {
  const parsed = productUpdateSchema.safeParse(input);
  if (!parsed.success) throw invalidInput(parsed.error);

  return inTransaction(db, async (tx) => {
    const row = await tx.product.findUnique({ where: { id } });
    if (!row) throw new ProductError("NOT_FOUND", "Product not found");
    const changed = changedProductFields(row, parsed.data);
    if (changed.length === 0) return { product: row, changed };
    const product = await tx.product.update({
      where: { id },
      data: parsed.data,
    });
    return { product, changed };
  });
}

/**
 * Hard-deletes an inactive product after the slug is typed back. No foreign
 * key references `Product` and `AuditEvent.targetId` is plain text, so the
 * history survives. Returns the deleted row.
 */
export async function deleteProduct(
  id: string,
  confirmSlug: string,
  { db = prisma }: { db?: Db } = {},
): Promise<Product> {
  return inTransaction(db, async (tx) => {
    const row = await tx.product.findUnique({ where: { id } });
    if (!row) throw new ProductError("NOT_FOUND", "Product not found");
    if (row.isActive) {
      throw new ProductError("ACTIVE_PRODUCT", "Deactivate the product first");
    }
    if (confirmSlug !== row.slug) {
      throw new ProductError(
        "CONFIRMATION_MISMATCH",
        "confirmSlug does not match the product slug",
      );
    }
    await tx.product.delete({ where: { id } });
    return row;
  });
}
