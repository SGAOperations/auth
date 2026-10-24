import "server-only";
import { z } from "zod";
import { MAX_REDIRECT_LENGTH } from "@/lib/product-registry";
import type { Logger } from "@/lib/log/logger";

// Contract: docs/LOGOUT.md. Dependencies are injected, so nothing here reads
// env or opens a connection. src/app/logout and src/app/api/sgauth/sessions
// wire the real ones.

const NO_STORE = "no-store";
const PRINTABLE_ASCII = /^[\x21-\x7e]+$/;
const ABSOLUTE_HTTP = /^https?:\/\//i;

/** True only for `Sec-Fetch-Site: cross-site`; a missing header is allowed. */
export function isCrossSiteRequest(headers: Pick<Headers, "get">): boolean {
  return headers.get("sec-fetch-site")?.trim().toLowerCase() === "cross-site";
}

/** True for the headers a prefetching `<Link>` or browser sends. */
export function isPrefetchRequest(headers: Pick<Headers, "get">): boolean {
  return (
    headers.get("next-router-prefetch") === "1" ||
    headers.get("purpose")?.toLowerCase() === "prefetch" ||
    headers.get("sec-purpose")?.toLowerCase().includes("prefetch") === true
  );
}

interface RedirectDeps {
  sgauthOrigin: string;
  /** `http:` product targets, for local development only. */
  allowHttpProducts: boolean;
  isAllowedRedirect(href: string): boolean | Promise<boolean>;
}

const redirectInput = z.string().min(1).max(MAX_REDIRECT_LENGTH);

function parseRedirectCandidate(
  raw: unknown,
  { sgauthOrigin, allowHttpProducts }: Omit<RedirectDeps, "isAllowedRedirect">,
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
 * The URL to send the browser to after sign-out: SGAuth itself or a registered
 * product origin. Every failure, including a throwing registry, gives `/login`.
 */
export async function resolveLogoutRedirect(
  raw: unknown,
  deps: RedirectDeps,
): Promise<string> {
  const fallback = new URL("/login", deps.sgauthOrigin).href;
  const url = parseRedirectCandidate(raw, deps);
  if (!url) return fallback;
  if (url.origin === deps.sgauthOrigin) return url.href;
  try {
    return (await deps.isAllowedRedirect(url.href)) ? url.href : fallback;
  } catch {
    return fallback;
  }
}

interface LogoutAuth {
  api: {
    signOut(options: {
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers }>;
  };
}

interface LogoutHandlerDeps extends RedirectDeps {
  auth: LogoutAuth;
  log: Pick<Logger, "warn" | "error">;
}

const logoutQuery = z.object({ redirect: z.unknown().optional() });

export function createLogoutHandler({
  auth,
  log,
  ...redirectDeps
}: LogoutHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (isCrossSiteRequest(req.headers)) {
      log.warn("Rejected cross-site logout");
      return new Response(
        "Sign-out must start from an SGA site. Nothing was changed.",
        {
          status: 403,
          headers: {
            "Content-Type": "text/plain; charset=utf-8",
            "Cache-Control": NO_STORE,
          },
        },
      );
    }
    if (isPrefetchRequest(req.headers)) {
      return new Response(null, {
        status: 204,
        headers: { "Cache-Control": NO_STORE },
      });
    }

    // A repeated param collapses to one value, never an error.
    const { redirect } = logoutQuery.parse(
      Object.fromEntries(new URL(req.url).searchParams),
    );

    const headers = new Headers({ "Cache-Control": NO_STORE });
    try {
      const signedOut = await auth.api.signOut({
        headers: req.headers,
        returnHeaders: true,
      });
      for (const cookie of signedOut.headers.getSetCookie()) {
        headers.append("Set-Cookie", cookie);
      }
    } catch (error) {
      // Better Auth has already logged it and still expires the cookie.
      log.error("Logout sign-out failed", {
        errorName: error instanceof Error ? error.name : "UnknownError",
      });
    }

    headers.set(
      "Location",
      await resolveLogoutRedirect(redirect, redirectDeps),
    );
    return new Response(null, { status: 303, headers });
  };
}

interface RevokeAllHandlerDeps {
  auth: { handler(request: Request): Promise<Response> };
}

const revokeAllBody = z.strictObject({});

function isValidRevokeAllBody(text: string): boolean {
  if (text === "") return true;
  try {
    return revokeAllBody.safeParse(JSON.parse(text)).success;
  } catch {
    return false;
  }
}

/**
 * Forwards to Better Auth's `/revoke-sessions`, so the origin check, the
 * session middleware and the SESSIONS_REVOKED audit adapter all apply.
 */
export function createRevokeAllHandler({
  auth,
}: RevokeAllHandlerDeps): (req: Request) => Promise<Response> {
  return async (req) => {
    if (!isValidRevokeAllBody(await req.text())) {
      return Response.json(
        { code: "INVALID_BODY", message: "Invalid request body." },
        { status: 400, headers: { "Cache-Control": NO_STORE } },
      );
    }

    const headers = new Headers(req.headers);
    headers.set("content-type", "application/json");
    headers.delete("content-length");
    const forwarded = new Request(
      new URL("/api/auth/revoke-sessions", req.url),
      { method: "POST", headers, body: "{}" },
    );

    const response = await auth.handler(forwarded);
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", NO_STORE);
    return result;
  };
}
