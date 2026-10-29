import { PRODUCT_BASE_URL_RE } from "@/lib/product-input";

// Pure and client-safe: no database, no `server-only`.

export interface ToolProduct {
  id: string;
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  isActive: boolean;
  visibleToPositionKeys: readonly string[];
}

/**
 * The products a user may see: active, with a well-formed base URL, and either
 * open to everyone (no keys) or sharing a key with the user's positions. Keeps
 * the input order.
 */
export function visibleTools<T extends ToolProduct>(
  products: readonly T[],
  positionKeys: ReadonlySet<string>,
): T[] {
  return products.filter(
    (product) =>
      product.isActive &&
      // The database already enforces this; it is checked again before a value
      // becomes an href.
      PRODUCT_BASE_URL_RE.test(product.baseUrl) &&
      (product.visibleToPositionKeys.length === 0 ||
        product.visibleToPositionKeys.some((key) => positionKeys.has(key))),
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
