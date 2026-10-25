import "server-only";
import { cookies } from "next/headers";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { isAllowedRedirect } from "@/lib/products";
import { openRedirect, redirectCookieOptions } from "@/lib/redirect/cookie";
import { resolveRedirect } from "@/lib/redirect/validate";

const settings = toAuthSettings(env);

/**
 * The URL to send the browser to once the user is signed in, or `/account`.
 * Re-validates the stored target against the live registry, so a product
 * deactivated mid-flow is not honored, and clears the cookie.
 *
 * Call it only from a server action or route handler, after the session is
 * established (sign-in, verification or reset success). Every failure is the
 * `/account` fallback, never an error.
 */
export async function consumeRedirect(): Promise<string> {
  const { name, ...options } = redirectCookieOptions(settings.baseURL);
  const store = await cookies();
  const token = store.get(name)?.value;

  let target: string | null = null;
  if (token !== undefined) {
    store.set(name, "", { ...options, maxAge: 0 });
    target = await openRedirect(token, settings.secret);
  }

  return resolveRedirect(target, {
    sgauthOrigin: new URL(settings.baseURL).origin,
    allowHttpProducts: settings.sgauthEnv === "local",
    isAllowedRedirect,
  });
}
