// Pure and client-safe: no database, no `server-only`. The gate that decides who
// sees a product on account pages. product-admin.ts asserts that the tuple
// below matches the generated Prisma enum, and the rule in `visibilityKeysIssue`
// mirrors the `Product_visibility_keys_check` CHECK.

export const PRODUCT_VISIBILITIES = [
  "EVERYONE",
  "LEADERSHIP",
  "POSITIONS",
  "UNSET",
] as const;

export type ProductVisibility = (typeof PRODUCT_VISIBILITIES)[number];

export const PRODUCT_VISIBILITY_COPY: Readonly<
  Record<ProductVisibility, { label: string; description: string }>
> = {
  EVERYONE: {
    label: "Anyone signed in",
    description: "Every signed-in SGA account sees it.",
  },
  LEADERSHIP: {
    label: "Leadership",
    description: "People who hold a leadership position.",
  },
  POSITIONS: {
    label: "Specific positions",
    description: "People who hold at least one of the positions you pick.",
  },
  UNSET: {
    label: "Not set yet",
    description: "Hidden from everyone. Use this until the product is live.",
  },
};

export const KEYS_REQUIRED_MESSAGE = "Choose at least one position.";
export const KEYS_NOT_ALLOWED_MESSAGE =
  "Positions apply only to Specific positions.";

/**
 * The problem with a gate and its position keys, or null when they agree:
 * Specific positions needs at least one key, and every other gate needs none.
 */
export function visibilityKeysIssue(
  visibility: ProductVisibility,
  keys: readonly string[],
): string | null {
  if (visibility === "POSITIONS") {
    return keys.length === 0 ? KEYS_REQUIRED_MESSAGE : null;
  }
  return keys.length > 0 ? KEYS_NOT_ALLOWED_MESSAGE : null;
}

export type ProductGate = {
  visibility: ProductVisibility;
  visibleToPositionKeys: readonly string[];
};

export type ProductViewer = {
  positionKeys: ReadonlySet<string>;
  isLeadership: boolean;
};

/** Whether a viewer may see a product listed. Unknown or empty gates fail closed. */
export function canViewProduct(
  product: ProductGate,
  viewer: ProductViewer,
): boolean {
  switch (product.visibility) {
    case "EVERYONE":
      return true;
    case "LEADERSHIP":
      return viewer.isLeadership;
    case "POSITIONS":
      return product.visibleToPositionKeys.some((key) =>
        viewer.positionKeys.has(key),
      );
    case "UNSET":
      return false;
  }
}

/** The "Visible to" text for the products list. */
export function visibilitySummary(product: ProductGate): string {
  if (product.visibility === "POSITIONS") {
    const count = product.visibleToPositionKeys.length;
    return count === 1 ? "1 position" : `${count} positions`;
  }
  switch (product.visibility) {
    case "EVERYONE":
      return "Anyone signed in";
    case "LEADERSHIP":
      return "Leadership";
    case "UNSET":
      return "Not set yet";
  }
}
