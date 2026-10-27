import "server-only";
import { symmetricDecodeJWT, symmetricEncodeJWT } from "better-auth/crypto";
import type { NextRequest, NextResponse } from "next/server";
import {
  parseRedirectCandidate,
  type RedirectSyntaxOptions,
} from "@/lib/redirect/validate";

// The target of `/login?redirect=` rides in a sealed cookie through sign-up,
// verification and reset, never in hidden form fields. The proxy only checks
// syntax here; the registry check runs when the target is consumed.

export const REDIRECT_PARAM = "redirect";
export const REDIRECT_COOKIE_MAX_AGE = 3600;
// Domain-separates the seal from every other use of the secret.
const SEAL_SALT = "sgauth.post-login-redirect";

/** Entry pages that may carry `?redirect=`. */
export const REDIRECT_ENTRY_PATHS = ["/login", "/sign-up", "/forgot-password"];

export interface RedirectCookieConfig extends RedirectSyntaxOptions {
  secret: string;
  baseURL: string;
}

/**
 * Host-only on purpose (no `Domain`): sibling product subdomains can neither
 * read nor plant it. `Lax`, not `Strict`, so a verify link opened from webmail
 * still carries it on the top-level navigation.
 */
export function redirectCookieOptions(baseURL: string) {
  const secure = new URL(baseURL).protocol === "https:";
  return {
    name: secure ? "__Host-sgauth.redirect" : "sgauth.redirect",
    httpOnly: true,
    secure,
    sameSite: "lax",
    path: "/",
    maxAge: REDIRECT_COOKIE_MAX_AGE,
  } as const;
}

export function sealRedirect(target: string, secret: string): Promise<string> {
  return symmetricEncodeJWT(
    { t: target },
    secret,
    SEAL_SALT,
    REDIRECT_COOKIE_MAX_AGE,
  );
}

/** The sealed target, or `null` for anything tampered, expired or malformed. */
export async function openRedirect(
  token: string,
  secret: string,
): Promise<string | null> {
  try {
    const payload = await symmetricDecodeJWT<{ t?: unknown }>(
      token,
      secret,
      SEAL_SALT,
    );
    return typeof payload?.t === "string" ? payload.t : null;
  } catch {
    return null;
  }
}

/**
 * Stores or clears the target for a request to an entry page. An absent param
 * leaves the cookie alone, so returning to `/login` keeps the earlier target;
 * a present but bad one clears it, so it never inherits an old good target.
 */
export async function captureRedirect(
  request: NextRequest,
  response: NextResponse,
  config: RedirectCookieConfig,
): Promise<void> {
  const raw = request.nextUrl.searchParams.get(REDIRECT_PARAM);
  if (raw === null) return;

  const { name, ...options } = redirectCookieOptions(config.baseURL);
  const url = parseRedirectCandidate(raw, config);
  if (url === null) {
    response.cookies.set(name, "", { ...options, maxAge: 0 });
    return;
  }
  response.cookies.set(
    name,
    await sealRedirect(url.href, config.secret),
    options,
  );
}
