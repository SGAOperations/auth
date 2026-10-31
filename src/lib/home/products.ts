import { toolHref, toolLetter, type ToolProduct } from "@/lib/account/tools";
import { guideForProduct, type ResourceGroup } from "@/lib/home/resources";

// Pure and client-safe: no database, no `server-only`. This is the one place
// that decides what a viewer's home page carries, so leadership content is
// attached here on the server and a non-leader's payload never contains it.

export type TileTone = "violet" | "blue" | "red" | "green" | "neutral";

export const PRODUCT_TILES: Record<string, { tone: TileTone; letter: string }> =
  {
    vaultz: { tone: "violet", letter: "Z" },
    chambers: { tone: "blue", letter: "C" },
    senateportal: { tone: "red", letter: "S" },
    aplio: { tone: "green", letter: "A" },
  };

/** SGAuth's own registry row is the page you are on, so it gets no tile. */
export const SELF_PRODUCT_SLUG = "sgauth";

export interface HomeProduct {
  slug: string;
  name: string;
  description: string;
  href: string;
  tone: TileTone;
  letter: string;
  /** A same-origin path to the product's icon, or null for the letter. */
  iconSrc: string | null;
  leadership: ResourceGroup[] | null;
  guidePath: string | null;
}

// An own-property lookup, so a slug like "__proto__" gets the fallback.
function tileFor(slug: string): { tone: TileTone; letter: string } | null {
  return Object.hasOwn(PRODUCT_TILES, slug) ? PRODUCT_TILES[slug] : null;
}

/**
 * The icon's path and query when it is on `ownOrigin`, otherwise null. The CSP
 * allows images from this origin only, so any other or malformed value falls
 * back to the letter and the client never receives a foreign URL.
 */
export function sameOriginIconSrc(
  iconUrl: string | null,
  ownOrigin: string,
): string | null {
  if (!iconUrl) return null;
  try {
    const url = new URL(iconUrl);
    return url.origin === ownOrigin ? url.pathname + url.search : null;
  } catch {
    return null;
  }
}

export function toHomeProducts(
  tools: readonly ToolProduct[],
  viewer: { isLeadership: boolean },
  ownOrigin: string,
): HomeProduct[] {
  return tools
    .filter((tool) => tool.slug !== SELF_PRODUCT_SLUG)
    .map((tool) => {
      const tile = tileFor(tool.slug);
      const guide = viewer.isLeadership ? guideForProduct(tool.slug) : null;
      return {
        slug: tool.slug,
        name: tool.name,
        description: tool.description,
        href: toolHref(tool.baseUrl),
        tone: tile?.tone ?? "neutral",
        letter: tile?.letter ?? toolLetter(tool.name),
        iconSrc: sameOriginIconSrc(tool.iconUrl, ownOrigin),
        leadership: guide ? guide.groups : null,
        guidePath: guide ? guide.path : null,
      };
    });
}
