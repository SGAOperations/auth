import { z } from "zod";
import { positionKeySchema } from "./position-key";

// Pure and client-safe: no database, no `server-only`. Every rule mirrors a
// CHECK in the product_registry migration, and input is rejected rather than
// normalised, so what passes here is byte-identical to what the database accepts.

export const PRODUCT_SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const PRODUCT_BASE_URL_RE =
  /^https:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+northeasternsga\.com$/;
export const PRODUCT_LOGIN_PATH_RE = /^\/([^/\\\s][^\\\s]*)?$/;

const ICON_URL_RE = /^https:\/\/\S+$/;
const MAX_VISIBLE_POSITION_KEYS = 50;

const slug = z
  .string()
  .min(2)
  .max(64)
  .regex(
    PRODUCT_SLUG_RE,
    "Slug must be lower-case letters, digits and single hyphens, e.g. my-product.",
  );

const name = z.string().trim().min(2).max(100);

const description = z.string().trim().max(500);

const baseUrl = z
  .string()
  .max(253)
  .regex(
    PRODUCT_BASE_URL_RE,
    "Base URL must be https://<name>.northeasternsga.com with no path or trailing slash.",
  );

const iconUrl = z
  .string()
  .max(2048)
  .regex(
    ICON_URL_RE,
    "Icon URL must start with https:// and contain no spaces.",
  )
  .refine((value) => URL.canParse(value), "Icon URL must be a valid URL.")
  .nullish();

const isActive = z.boolean();

const sortOrder = z.number().int().min(0).max(10000);

const visibleToPositionKeys = z
  .array(positionKeySchema)
  .max(MAX_VISIBLE_POSITION_KEYS)
  .transform((keys) => [...new Set(keys)]);

const loginRedirectPath = z
  .string()
  .max(512)
  .regex(
    PRODUCT_LOGIN_PATH_RE,
    "Login redirect path must start with a single / and contain no spaces or backslashes.",
  )
  .nullish();

export const productCreateSchema = z.strictObject({
  slug,
  name,
  description: description.default(""),
  baseUrl,
  iconUrl,
  isActive: isActive.default(true),
  sortOrder: sortOrder.default(0),
  visibleToPositionKeys: visibleToPositionKeys.default([]),
  loginRedirectPath,
});

// Built from the bare field schemas, not `productCreateSchema.partial()`, so an
// omitted field stays omitted instead of picking up its create-time default.
// `slug` is absent from the shape: an update that carries it fails parsing.
export const productUpdateSchema = z.strictObject({
  name: name.optional(),
  description: description.optional(),
  baseUrl: baseUrl.optional(),
  iconUrl,
  isActive: isActive.optional(),
  sortOrder: sortOrder.optional(),
  visibleToPositionKeys: visibleToPositionKeys.optional(),
  loginRedirectPath,
});

export type ProductCreateInput = z.infer<typeof productCreateSchema>;
export type ProductUpdateInput = z.infer<typeof productUpdateSchema>;
