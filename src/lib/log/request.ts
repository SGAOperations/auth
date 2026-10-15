import "server-only";
import { runWithRequestContext } from "@/lib/log/context";
import type { Logger } from "@/lib/log/logger";

const REQUEST_ID_PATTERN = /^[\w:.-]{1,128}$/;

/** Vercel's request id when it is well formed, otherwise a fresh UUID. */
export function resolveRequestId(headers: Headers): string {
  const vercelId = headers.get("x-vercel-id");
  return vercelId && REQUEST_ID_PATTERN.test(vercelId)
    ? vercelId
    : crypto.randomUUID();
}

// A segment right after one of these can carry a credential, as in
// /api/auth/reset-password/<token> or /api/auth/callback/<provider>.
const TOKEN_PARENT_SEGMENTS: ReadonlySet<string> = new Set([
  "reset-password",
  "verify-email",
  "magic-link",
  "callback",
  "token",
  "verify",
  "unlock",
]);

// Auth route names are short lowercase words joined by hyphens. Anything else
// (ids, random strings, encoded values) is not a route name.
const ROUTE_WORD = /^[a-z]{1,30}(-[a-z]{1,30}){0,3}$/;

/**
 * Replaces every path segment that could carry a token with [REDACTED]:
 * the segment after a token-bearing route name, and any segment that is not a
 * plain route word. The query string is never part of the input.
 */
export function scrubPath(pathname: string): string {
  let afterTokenParent = false;
  return pathname
    .split("/")
    .map((segment) => {
      if (segment === "") return segment;
      const scrub = afterTokenParent || !ROUTE_WORD.test(segment);
      afterTokenParent = TOKEN_PARENT_SEGMENTS.has(segment);
      return scrub ? "[REDACTED]" : segment;
    })
    .join("/");
}

function outcomeFor(status: number) {
  if (status >= 500) return "server_error";
  if (status >= 400) return "client_error";
  return "success";
}

/**
 * Wraps a route handler so every request writes one `request.completed` line
 * with its latency and outcome, and every line written while it runs carries
 * the request id. It reads nothing from the request but the URL path and
 * `x-vercel-id`: never the query string (reset tokens travel there), other
 * headers or the body. Token-bearing path segments are scrubbed.
 */
export function withRequestLogging(
  route: string,
  handler: (req: Request) => Promise<Response>,
  log: Logger,
): (req: Request) => Promise<Response> {
  return async (req) => {
    const startedAt = performance.now();
    const context = {
      requestId: resolveRequestId(req.headers),
      route,
      method: req.method,
      path: scrubPath(new URL(req.url).pathname),
    };

    return runWithRequestContext(context, async () => {
      try {
        const response = await handler(req);
        const outcome = outcomeFor(response.status);
        const fields = {
          status: response.status,
          latencyMs: Math.round(performance.now() - startedAt),
          outcome,
        };
        if (outcome === "server_error") log.error("request.completed", fields);
        else log.info("request.completed", fields);
        return response;
      } catch (err) {
        log.error("request.failed", {
          err,
          latencyMs: Math.round(performance.now() - startedAt),
          outcome: "exception",
        });
        throw err;
      }
    });
  };
}
