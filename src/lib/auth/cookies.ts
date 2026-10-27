import "server-only";
import type { BetterAuthOptions } from "better-auth";
import type { SgauthEnv } from "@/lib/env-schema";

// Cookie contract and threat model: docs/SESSION-COOKIE.md. The attributes are
// fixed by design (docs/ENGINEERING.md section 3): change them only with a
// design change.

export const PARENT_COOKIE_DOMAIN = "northeasternsga.com";
// Browsers resolve every *.localhost name to loopback, so a product on
// vaultz.sga.localhost shares this cookie with auth.sga.localhost. It may be
// replaced with sga.test if a browser rejects the Domain attribute (see
// docs/ENVIRONMENTS.md, "Local development").
export const LOCAL_COOKIE_DOMAIN = "sga.localhost";

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
      // Plain HTTP on loopback, so no Secure attribute and no __Secure- prefix.
      return {
        prefix: "sgauth-local",
        domain: LOCAL_COOKIE_DOMAIN,
        secure: false,
      };
  }
}

/** Mirrors Better Auth's own naming of the session cookie. */
export function sessionCookieName(policy: CookiePolicy): string {
  return `${policy.secure ? "__Secure-" : ""}${policy.prefix}.session_token`;
}

/** One year; each login re-sets it. */
export const DEVICE_COOKIE_MAX_AGE_SECONDS = 365 * 24 * 60 * 60;

/**
 * The known-device cookie (docs/SESSION-COOKIE.md, "Known-device cookie").
 * Unlike the session cookie it is host-only even where the session cookie is
 * parent-domain: only the auth host ever reads it, and a product site must
 * never see it.
 */
export function deviceCookieName(policy: CookiePolicy): string {
  return `${policy.secure ? "__Secure-" : ""}${policy.prefix}.device`;
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

interface CookieConfigInput {
  sgauthEnv: SgauthEnv;
  baseURL: string;
  /** Vercel's own `VERCEL_ENV`; any non-empty value means "running on Vercel". */
  vercelEnv: string | undefined;
  /** The exact object passed to `betterAuth()`. */
  advanced: NonNullable<BetterAuthOptions["advanced"]>;
}

const SHARED_PREFIXES: Partial<Record<SgauthEnv, string>> = {
  production: "sgauth",
  dev: "sgauth-dev",
};

/** True when the URL parses and its host ends in `.localhost`. */
function isLocalhostName(url: string): boolean {
  try {
    return new URL(url).hostname.endsWith(".localhost");
  } catch {
    return false;
  }
}

/**
 * Refuses to boot with an insecure cookie configuration. It checks the object
 * Better Auth will receive, not the policy, so a later override cannot bypass
 * it. Lines carry the rule only, never a value beyond the two env names.
 */
export function assertSecureCookieConfig(input: CookieConfigInput): void {
  const { sgauthEnv, baseURL, vercelEnv, advanced } = input;
  const failures: string[] = [];

  if (sgauthEnv === "local") {
    if (vercelEnv) failures.push("SGAUTH_ENV=local cannot run on Vercel");
    if (!isLocalhostName(baseURL)) {
      failures.push("baseURL host must end in .localhost");
    }
    if (advanced.useSecureCookies !== false) {
      failures.push("useSecureCookies must be false");
    }
    const shared = advanced.crossSubDomainCookies;
    if (shared?.enabled !== true || shared.domain !== LOCAL_COOKIE_DOMAIN) {
      failures.push(
        `crossSubDomainCookies must be enabled on ${LOCAL_COOKIE_DOMAIN}`,
      );
    }
  } else {
    const attributes = advanced.defaultCookieAttributes;
    if (!baseURL.startsWith("https://")) {
      failures.push("baseURL must use https");
    }
    if (advanced.useSecureCookies !== true) {
      failures.push("useSecureCookies must be true");
    }
    if (attributes?.secure === false) {
      failures.push("defaultCookieAttributes.secure must not be false");
    }
    if (attributes?.httpOnly === false) {
      failures.push("defaultCookieAttributes.httpOnly must not be false");
    }
    if (attributes?.sameSite !== "lax") {
      failures.push('defaultCookieAttributes.sameSite must be "lax"');
    }
  }

  const sharedPrefix = SHARED_PREFIXES[sgauthEnv];
  if (sharedPrefix !== undefined) {
    const shared = advanced.crossSubDomainCookies;
    if (shared?.enabled !== true || shared.domain !== PARENT_COOKIE_DOMAIN) {
      failures.push(
        `crossSubDomainCookies must be enabled on ${PARENT_COOKIE_DOMAIN}`,
      );
    }
    if (advanced.cookiePrefix !== sharedPrefix) {
      failures.push(`cookiePrefix must be "${sharedPrefix}"`);
    }
  }

  if (failures.length > 0) {
    throw new Error(
      [
        `Insecure cookie configuration for SGAUTH_ENV=${sgauthEnv}:`,
        ...failures.map((failure) => `- ${failure}`),
      ].join("\n"),
    );
  }
}
