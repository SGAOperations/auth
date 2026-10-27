import "server-only";
import type { Analytics } from "@/lib/analytics/analytics";

type Handler = (req: Request) => Promise<Response>;

function isSessionEndpoint(req: Request): boolean {
  const pathname = new URL(req.url).pathname.replace(/\/+$/, "");
  return pathname.endsWith("/get-session");
}

/**
 * Reports a 5xx response or a thrown error from the session endpoint as a
 * `session_endpoint_error` event. Every other path passes straight through,
 * and the response or error is always returned unchanged. No user id is sent:
 * resolving one would cost a database round trip on a path that is already
 * failing.
 */
export function withSessionEndpointErrorCapture(
  handler: Handler,
  analytics: Pick<Analytics, "capture">,
): Handler {
  return async (req) => {
    if (!isSessionEndpoint(req)) return handler(req);

    let response: Response;
    try {
      response = await handler(req);
    } catch (err) {
      analytics.capture("session_endpoint_error", {
        properties: { status: null, kind: "exception" },
      });
      throw err;
    }
    if (response.status >= 500) {
      analytics.capture("session_endpoint_error", {
        properties: { status: response.status, kind: "server_error" },
      });
    }
    return response;
  };
}
