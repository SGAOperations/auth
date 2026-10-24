import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { corsPreflight, withCors } from "@/lib/security/cors-server";
import { sessionEndpoint } from "@/lib/sgauth-session/server";

export const runtime = "nodejs";

// GET only, as /api/sgauth/session. Contract: docs/SESSION-ENDPOINT.md,
// docs/CORS.md.
export const GET = withRequestLogging(
  "/api/sgauth/session/minimal",
  withCors(sessionEndpoint.minimal),
  logger,
);
export const OPTIONS = withRequestLogging(
  "/api/sgauth/session/minimal",
  corsPreflight,
  logger,
);
