import { toNextJsHandler } from "better-auth/next-js";
import { analytics } from "@/lib/analytics";
import { withSessionEndpointErrorCapture } from "@/lib/analytics/route";
import { auth } from "@/lib/auth/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { withAuthRateLimit } from "@/lib/rate-limit/server";
import { corsPreflight, withCors } from "@/lib/security/cors-server";
import { withDuplicateCookieGuard } from "@/lib/security/duplicate-cookie-server";

const handlers = toNextJsHandler(auth);
const ROUTE = "/api/auth/[...all]";

// GET order: logging, then session-endpoint error capture, then rate limiting,
// then the duplicate-cookie guard. Capture sits inside logging so its event
// carries the request id, and outside rate limiting so only the endpoint's own
// 5xx counts. The guard is innermost so rate-limit keying still sees the
// original Cookie header. No GET path here is CORS-enabled, /api/auth/token
// included (browsers reach the token through a product-side server proxy), so
// GET is not wrapped in CORS.
export const GET = withRequestLogging(
  ROUTE,
  withSessionEndpointErrorCapture(
    withAuthRateLimit(withDuplicateCookieGuard(handlers.GET)),
    analytics,
  ),
  logger,
);
// POST order: logging, then CORS, then session-endpoint error capture, then
// rate limiting, then the duplicate-cookie guard, so a 429 on sign-out is
// readable cross-origin. CORS leaves every other POST path untouched. The
// guard is here because Better Auth also mounts /get-session on POST.
export const POST = withRequestLogging(
  ROUTE,
  withCors(
    withSessionEndpointErrorCapture(
      withAuthRateLimit(withDuplicateCookieGuard(handlers.POST)),
      analytics,
    ),
  ),
  logger,
);
export const OPTIONS = withRequestLogging(ROUTE, corsPreflight, logger);
