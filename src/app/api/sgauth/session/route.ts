import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { sessionEndpoint } from "@/lib/sgauth-session/server";

export const runtime = "nodejs";

// GET only: the session cookie is the credential and nothing is mutated.
// Contract: docs/SESSION-ENDPOINT.md.
export const GET = withRequestLogging(
  "/api/sgauth/session",
  sessionEndpoint.full,
  logger,
);
