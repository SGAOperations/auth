import type { FieldErrors, Resolver } from "react-hook-form";
import { productCreateSchema, productUpdateSchema } from "@/lib/product-input";

// Pure and client-safe, like product-input.ts: no database, no `server-only`.

export type ProductFormMode = "create" | "update";

/** What the form holds. Optional text is "" here and null in the payload. */
export interface ProductFormValues {
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  iconUrl: string;
  isActive: boolean;
  sortOrder: number;
  visibleToPositionKeys: string[];
  loginRedirectPath: string;
}

export const PRODUCT_FORM_DEFAULTS: ProductFormValues = {
  slug: "",
  name: "",
  description: "",
  baseUrl: "",
  iconUrl: "",
  isActive: true,
  sortOrder: 0,
  visibleToPositionKeys: [],
  loginRedirectPath: "",
};

const SLUG_MAX = 64;

/** A kebab-case slug for a product name. The admin can still edit it. */
export function suggestProductSlug(name: string): string {
  return name
    .toLowerCase()
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, SLUG_MAX)
    .replace(/-+$/, "");
}

export interface ProductPayload extends Omit<
  ProductFormValues,
  "slug" | "iconUrl" | "loginRedirectPath"
> {
  slug?: string;
  iconUrl: string | null;
  loginRedirectPath: string | null;
}

/**
 * The form values as the schemas and the server actions take them. Only blank
 * optional text becomes null; nothing else is normalised, because
 * `product-input.ts` rejects rather than repairs.
 */
export function toProductPayload(
  values: ProductFormValues,
  mode: ProductFormMode,
): ProductPayload {
  const { slug, iconUrl, loginRedirectPath, ...rest } = values;
  return {
    ...(mode === "create" ? { slug } : {}),
    ...rest,
    iconUrl: iconUrl === "" ? null : iconUrl,
    loginRedirectPath: loginRedirectPath === "" ? null : loginRedirectPath,
  };
}

/** The saved row as form values. */
export function productToFormValues(product: {
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  iconUrl: string | null;
  isActive: boolean;
  sortOrder: number;
  visibleToPositionKeys: string[];
  loginRedirectPath: string | null;
}): ProductFormValues {
  return {
    ...product,
    iconUrl: product.iconUrl ?? "",
    loginRedirectPath: product.loginRedirectPath ?? "",
  };
}

const FORM_FIELDS: ReadonlySet<string> = new Set(
  Object.keys(PRODUCT_FORM_DEFAULTS),
);

function isFormField(key: unknown): key is keyof ProductFormValues {
  return typeof key === "string" && FORM_FIELDS.has(key);
}

/** The first message of each server field error that names a form field. */
export function fieldMessages(
  fieldErrors: Record<string, string[]>,
): Array<[keyof ProductFormValues, string]> {
  const messages: Array<[keyof ProductFormValues, string]> = [];
  for (const [key, entries] of Object.entries(fieldErrors)) {
    const message = entries[0];
    if (isFormField(key) && message) messages.push([key, message]);
  }
  return messages;
}

/** Validates the payload the server would see, so both sides agree. */
export function productFormResolver(
  mode: ProductFormMode,
): Resolver<ProductFormValues> {
  const schema = mode === "create" ? productCreateSchema : productUpdateSchema;
  return async (values) => {
    const parsed = schema.safeParse(toProductPayload(values, mode));
    if (parsed.success) return { values, errors: {} };
    const errors: FieldErrors<ProductFormValues> = {};
    for (const issue of parsed.error.issues) {
      const key = issue.path[0];
      if (isFormField(key) && !errors[key]) {
        errors[key] = { type: "validation", message: issue.message };
      }
    }
    return { values: {}, errors };
  };
}
