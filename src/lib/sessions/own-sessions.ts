import "server-only";
import { isAPIError } from "better-auth/api";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import { describeDevice } from "@/lib/sessions/device";

export interface SessionView {
  id: string;
  createdAt: string;
  lastActiveAt: string;
  ip: string | null;
  device: string;
  isCurrent: boolean;
}

export interface CookieAttributes {
  domain?: string;
  path?: string;
  secure?: boolean;
  httpOnly?: boolean;
  sameSite?: string;
}

export type AuthCookies = Record<
  "sessionToken" | "sessionData" | "dontRememberToken",
  { name: string; attributes: CookieAttributes }
>;

export interface OwnSessionDeps {
  db: Pick<PrismaClient, "session">;
  getCaller(
    headers: Headers,
  ): Promise<{ userId: string; sessionId: string } | null>;
  revokeByToken(token: string, headers: Headers): Promise<void>;
  authContext(): Promise<{
    authCookies: AuthCookies;
    isTrustedOrigin(
      url: string,
      settings?: { allowRelativePaths?: boolean },
    ): boolean;
  }>;
}

interface SessionRow {
  id: string;
  createdAt: Date;
  updatedAt: Date;
  ipAddress: string | null;
  userAgent: string | null;
}

/** The slice of a Better Auth instance this module uses. */
interface AuthLike {
  api: {
    getSession(input: {
      headers: Headers;
      query: { disableRefresh: true };
    }): Promise<{ session: { id: string }; user: { id: string } } | null>;
    revokeSession(input: {
      body: { token: string };
      headers: Headers;
    }): Promise<unknown>;
  };
  $context: Promise<{
    authCookies: AuthCookies;
    isTrustedOrigin(
      url: string,
      settings?: { allowRelativePaths?: boolean },
    ): boolean;
  }>;
}

export function betterAuthSessionDeps(
  auth: AuthLike,
  db: Pick<PrismaClient, "session">,
): OwnSessionDeps {
  return {
    db,
    async getCaller(headers) {
      try {
        const result = await auth.api.getSession({
          headers,
          // Read only: no refresh, so no Set-Cookie to forward.
          query: { disableRefresh: true },
        });
        return result
          ? { userId: result.user.id, sessionId: result.session.id }
          : null;
      } catch (error) {
        // A deactivated user surfaces as an APIError from the after-hook.
        if (isAPIError(error)) return null;
        throw error;
      }
    },
    async revokeByToken(token, headers) {
      await auth.api.revokeSession({ body: { token }, headers });
    },
    authContext: () => auth.$context,
  };
}

/** The request's origin: `Origin`, else the origin of `Referer`. */
export function requestOrigin(headers: Headers): string | null {
  const origin = headers.get("origin");
  if (origin && origin !== "null") return origin;
  const referer = headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

export function toSessionView(
  row: SessionRow,
  currentSessionId: string,
): SessionView {
  return {
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    lastActiveAt: row.updatedAt.toISOString(),
    // "" means a refused multi-hop x-forwarded-for.
    ip: row.ipAddress || null,
    device: describeDevice(row.userAgent),
    isCurrent: row.id === currentSessionId,
  };
}

/** Current session first, then most recent activity, then newest. */
export function sortSessionViews(views: readonly SessionView[]): SessionView[] {
  return [...views].sort((a, b) => {
    if (a.isCurrent !== b.isCurrent) return a.isCurrent ? -1 : 1;
    if (a.lastActiveAt !== b.lastActiveAt) {
      return a.lastActiveAt < b.lastActiveAt ? 1 : -1;
    }
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1;
    return 0;
  });
}

function sameSiteValue(value: string): string {
  return value.charAt(0).toUpperCase() + value.slice(1).toLowerCase();
}

/**
 * Appends one expiring `Set-Cookie` per Better Auth cookie, with the live
 * attributes, so Domain, Path and Secure match the cookie being cleared.
 */
export function expireSessionCookies(
  headers: Headers,
  authCookies: AuthCookies,
): void {
  for (const { name, attributes } of Object.values(authCookies)) {
    const parts = [`${name}=`, "Max-Age=0"];
    if (attributes.domain) parts.push(`Domain=${attributes.domain}`);
    parts.push(`Path=${attributes.path ?? "/"}`);
    if (attributes.httpOnly) parts.push("HttpOnly");
    if (attributes.secure) parts.push("Secure");
    if (attributes.sameSite) {
      parts.push(`SameSite=${sameSiteValue(attributes.sameSite)}`);
    }
    headers.append("Set-Cookie", parts.join("; "));
  }
}

const sessionId = z.uuid();

function jsonResponse(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store", Vary: "Cookie" },
  });
}

const unauthenticated = () => jsonResponse({ error: "unauthenticated" }, 401);
const notFound = () => jsonResponse({ error: "not_found" }, 404);
const invalidOrigin = () => jsonResponse({ error: "invalid_origin" }, 403);

export function createOwnSessionHandlers(deps: OwnSessionDeps) {
  return {
    async list(request: Request): Promise<Response> {
      const caller = await deps.getCaller(request.headers);
      if (!caller) return unauthenticated();

      const now = new Date();
      const rows = await deps.db.session.findMany({
        where: {
          userId: caller.userId,
          expiresAt: { gt: now },
          absoluteExpiresAt: { gt: now },
        },
        select: {
          id: true,
          createdAt: true,
          updatedAt: true,
          ipAddress: true,
          userAgent: true,
        },
      });
      const sessions = sortSessionViews(
        rows.map((row) => toSessionView(row, caller.sessionId)),
      );
      return jsonResponse({ sessions }, 200);
    },

    async revoke(request: Request, id: string): Promise<Response> {
      // Before the identity lookup, so a cross-origin probe learns nothing.
      const context = await deps.authContext();
      const origin = requestOrigin(request.headers);
      if (
        !origin ||
        !context.isTrustedOrigin(origin, { allowRelativePaths: false })
      ) {
        return invalidOrigin();
      }

      const caller = await deps.getCaller(request.headers);
      if (!caller) return unauthenticated();

      if (!sessionId.safeParse(id).success) return notFound();
      const target = await deps.db.session.findFirst({
        where: { id, userId: caller.userId, expiresAt: { gt: new Date() } },
        select: { id: true, token: true },
      });
      if (!target) return notFound();

      try {
        await deps.revokeByToken(target.token, request.headers);
      } catch (error) {
        // The caller's own session vanished mid-request.
        if (isAPIError(error)) return unauthenticated();
        throw error;
      }

      const headers = new Headers({
        "Cache-Control": "no-store",
        Vary: "Cookie",
      });
      if (target.id === caller.sessionId) {
        expireSessionCookies(headers, context.authCookies);
      }
      return new Response(null, { status: 204, headers });
    },
  };
}
