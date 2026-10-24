import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { corsPreflight, withCors } from "@/lib/security/cors-server";
import { sessionEndpoint } from "@/lib/sgauth-session/server";

export const runtime = "nodejs";

// GET only: the session cookie is the credential and nothing is mutated.
// CORS sits inside request logging, so a 401 or 429 carries CORS headers.
// Contract: docs/SESSION-ENDPOINT.md, docs/CORS.md.
export const GET = withRequestLogging(
  "/api/sgauth/session",
  withCors(sessionEndpoint.full),
  logger,
);
export const OPTIONS = withRequestLogging(
  "/api/sgauth/session",
  corsPreflight,
  logger,
);
