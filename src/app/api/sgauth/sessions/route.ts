import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { ownSessions } from "@/lib/sessions/server";

export const runtime = "nodejs";

export const GET = withRequestLogging(
  "/api/sgauth/sessions",
  (req) => ownSessions.list(req),
  logger,
);
