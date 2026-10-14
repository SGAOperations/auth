import "server-only";
import type { BetterAuthOptions } from "better-auth";
import type { SgauthEnv } from "@/lib/auth/settings";

// Cookie contract and threat model: docs/SESSION-COOKIE.md. The attributes are
// fixed by design (docs/ENGINEERING.md section 3): change them only with a
// design change.

export const PARENT_COOKIE_DOMAIN = "northeasternsga.com";

export interface CookiePolicy {
  prefix: string;
  /** `null` means a host-only cookie. */
  domain: string | null;
  secure: boolean;
}

// Exhaustive on purpose: a new SgauthEnv fails `tsc` until it gets a row.
export function resolveCookiePolicy(env: SgauthEnv): CookiePolicy {
  switch (env) {
    case "production":
      return { prefix: "sgauth", domain: PARENT_COOKIE_DOMAIN, secure: true };
    case "dev":
      return {
        prefix: "sgauth-dev",
        domain: PARENT_COOKIE_DOMAIN,
        secure: true,
      };
    case "preview":
      return { prefix: "sgauth-preview", domain: null, secure: true };
    case "local":
      // Placeholder: #46 (AUTH-T34) owns this row and sets Domain=sga.localhost.
      return { prefix: "sgauth-local", domain: null, secure: false };
  }
}

/** Mirrors Better Auth's own naming of the session cookie. */
export function sessionCookieName(policy: CookiePolicy): string {
  return `${policy.secure ? "__Secure-" : ""}${policy.prefix}.session_token`;
}

type CookieOptions = Pick<
  NonNullable<BetterAuthOptions["advanced"]>,
  | "cookiePrefix"
  | "useSecureCookies"
  | "crossSubDomainCookies"
  | "defaultCookieAttributes"
>;

export function buildCookieOptions(policy: CookiePolicy): CookieOptions {
  return {
    cookiePrefix: policy.prefix,
    // Explicit, never inferred from baseURL.
    useSecureCookies: policy.secure,
    crossSubDomainCookies: policy.domain
      ? { enabled: true, domain: policy.domain }
      : { enabled: false },
    // No `domain` here: Better Auth spreads these after the cross-subdomain
    // domain, so it would override it or add a Domain to a host-only cookie.
    defaultCookieAttributes: {
      httpOnly: true,
      secure: policy.secure,
      sameSite: "lax",
      path: "/",
    },
  };
}
