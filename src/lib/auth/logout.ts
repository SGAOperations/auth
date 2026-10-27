import "server-only";
import { z } from "zod";
import type { Logger } from "@/lib/log/logger";
import { resolveRedirect, type RedirectDeps } from "@/lib/redirect/validate";

// Contract: docs/LOGOUT.md. Dependencies are injected, so nothing here reads
// env or opens a connection. src/app/logout and src/app/api/sgauth/sessions
// wire the real ones.

const NO_STORE = "no-store";

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

/**
 * The URL to send the browser to after sign-out: SGAuth itself or a registered
 * product origin. Every failure, including a throwing registry, gives `/login`.
 */
export function resolveLogoutRedirect(
  raw: unknown,
  deps: RedirectDeps,
): Promise<string> {
  return resolveRedirect(raw, deps, "/login");
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
