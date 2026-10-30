import { PRODUCT_BASE_URL_RE } from "@/lib/product-input";
import {
  canViewProduct,
  type ProductViewer,
  type ProductVisibility,
} from "@/lib/product-visibility";

// Pure and client-safe: no database, no `server-only`.

export interface ToolProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  isActive: boolean;
  visibility: ProductVisibility;
  visibleToPositionKeys: readonly string[];
}

/**
 * The products a viewer may see: active, with a well-formed base URL, and
 * allowed by the product's visibility gate. Keeps the input order.
 */
export function visibleTools<T extends ToolProduct>(
  products: readonly T[],
  viewer: ProductViewer,
): T[] {
  return products.filter(
    (product) =>
      product.isActive &&
      // The database already enforces this; it is checked again before a value
      // becomes an href.
      PRODUCT_BASE_URL_RE.test(product.baseUrl) &&
      canViewProduct(product, viewer),
  );
}

export function toolHref(baseUrl: string): string {
  return `${baseUrl}/`;
}

/** The first character of the name, upper-cased, or "?" when empty. */
export function toolLetter(name: string): string {
  const first = Array.from(name.trim())[0];
  return first ? first.toUpperCase() : "?";
}

/** A new array sorted by name, then key. */
export function sortPositionsForDisplay<
  T extends { key: string; name: string },
>(positions: readonly T[]): T[] {
  return [...positions].sort(
    (a, b) => a.name.localeCompare(b.name, "en") || a.key.localeCompare(b.key),
  );
}
