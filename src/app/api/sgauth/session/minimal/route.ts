import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { sessionEndpoint } from "@/lib/sgauth-session/server";

export const runtime = "nodejs";

// GET only, as /api/sgauth/session. Contract: docs/SESSION-ENDPOINT.md.
export const GET = withRequestLogging(
  "/api/sgauth/session/minimal",
  sessionEndpoint.minimal,
  logger,
);
