import { z } from "zod";
import { MAX_REDIRECT_LENGTH } from "@/lib/product-registry";

// Pure syntax and normalization for redirect targets, shared by the post-login
// cookie (src/lib/redirect) and sign-out (src/lib/auth/logout.ts). No env, no
// server-only guard: the proxy imports it too. The origin allowlist decision is
// injected, so the registry stays the only place that knows the products.

const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const ABSOLUTE_HTTP = /^https?:\/\//i;

export const FALLBACK_PATH = "/account";

export interface RedirectDeps {
  sgauthOrigin: string;
  /** `http:` product targets, for local development only. */
  allowHttpProducts: boolean;
  isAllowedRedirect(href: string): boolean | Promise<boolean>;
}

export type RedirectSyntaxOptions = Pick<
  RedirectDeps,
  "sgauthOrigin" | "allowHttpProducts"
>;

const redirectInput = z.string().min(1).max(MAX_REDIRECT_LENGTH);

/**
 * Parses a raw target into an absolute URL without its fragment, or `null`.
 * Printable ASCII only: the WHATWG parser strips tab, CR and LF and treats `\`
 * as `/`, which would turn `/\t/evil.com` into `//evil.com`. A relative target
 * always comes back absolute on the SGAuth origin, so a dot-segment trick can
 * never become a protocol-relative `Location`.
 */
export function parseRedirectCandidate(
  raw: unknown,
  { sgauthOrigin, allowHttpProducts }: RedirectSyntaxOptions,
): URL | null {
  const parsed = redirectInput.safeParse(raw);
  if (!parsed.success) return null;
  const value = parsed.data;
  if (!PRINTABLE_ASCII.test(value) || value.includes("\\")) return null;

  let url: URL;
  if (value.startsWith("/")) {
    if (value.startsWith("//")) return null;
    url = new URL(value, sgauthOrigin);
    if (url.origin !== sgauthOrigin) return null;
  } else if (ABSOLUTE_HTTP.test(value) && URL.canParse(value)) {
    url = new URL(value);
    if (url.username !== "" || url.password !== "") return null;
    if (
      url.protocol === "http:" &&
      url.origin !== sgauthOrigin &&
      !allowHttpProducts
    ) {
      return null;
    }
  } else {
    return null;
  }
  url.hash = "";
  return url;
}

/**
 * The URL to send the browser to: SGAuth itself or a registered product
 * origin. Every failure, including a throwing registry, gives `fallbackPath`
 * on the SGAuth origin.
 */
export async function resolveRedirect(
  raw: unknown,
  deps: RedirectDeps,
  fallbackPath: string = FALLBACK_PATH,
): Promise<string> {
  const fallback = new URL(fallbackPath, deps.sgauthOrigin).href;
  const url = parseRedirectCandidate(raw, deps);
  if (!url) return fallback;
  if (url.origin === deps.sgauthOrigin) return url.href;
  try {
    return (await deps.isAllowedRedirect(url.href)) ? url.href : fallback;
  } catch {
    return fallback;
  }
}
