import "server-only";
import { z } from "zod";
import { clientIp } from "@/lib/client-ip";
import type { Identifiers, RateLimiter } from "@/lib/rate-limit/limiter";
import { tooManyRequests } from "@/lib/rate-limit/limiter";
import { matchAuthRoute } from "@/lib/rate-limit/policies";

const AUTH_PREFIX = "/api/auth";

const emailBody = z.looseObject({ email: z.string().max(320) });

function authPath(request: Request): string {
  let path = new URL(request.url).pathname;
  if (path.startsWith(AUTH_PREFIX)) path = path.slice(AUTH_PREFIX.length);
  return path.length > 1 && path.endsWith("/") ? path.slice(0, -1) : path;
}

function readCookie(request: Request, name: string): string | undefined {
  const header = request.headers.get("cookie");
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const eq = part.indexOf("=");
    if (eq > 0 && part.slice(0, eq).trim() === name) {
      return part.slice(eq + 1).trim() || undefined;
    }
  }
  return undefined;
}

// A clone, so Better Auth can still read the body. Anything that does not
// parse is left to Better Auth's own validation and falls back to the IP key.
async function readEmail(request: Request): Promise<string | undefined> {
  const body: unknown = await request
    .clone()
    .json()
    .catch(() => null);
  const parsed = emailBody.safeParse(body);
  return parsed.success ? parsed.data.email : undefined;
}

interface AuthRouteOptions {
  limiter: RateLimiter;
  sessionCookieName: string;
}

/**
 * Wraps the Better Auth HTTP handler. It limits HTTP traffic only: trusted
 * server-side `auth.api.*` calls never pass through it. A route with no
 * policy, the session endpoint included, makes no backend call at all.
 */
export function createAuthRouteLimiter({
  limiter,
  sessionCookieName,
}: AuthRouteOptions) {
  return function withAuthRateLimit(
    handler: (request: Request) => Promise<Response>,
  ): (request: Request) => Promise<Response> {
    return async (request) => {
      const policy = matchAuthRoute(request.method, authPath(request));
      if (policy === null) return handler(request);

      const ip = clientIp(request.headers);
      const ids: Identifiers = { ip };

      // Fallbacks, so a limited route is never left unlimited: an absent email
      // or cookie keys its rule by IP instead of skipping it.
      if (policy === "passwordReset") {
        ids.email = await readEmail(request);
      } else if (policy === "verificationResend") {
        ids.email = (await readEmail(request)) ?? `ip:${ip}`;
      } else if (policy === "token") {
        ids.session = readCookie(request, sessionCookieName) ?? `ip:${ip}`;
      }

      const result = await limiter.check(policy, ids);
      return result.allowed
        ? handler(request)
        : tooManyRequests(result.retryAfterSeconds);
    };
  };
}
