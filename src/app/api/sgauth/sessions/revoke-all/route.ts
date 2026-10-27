import { auth } from "@/lib/auth/config";
import { createRevokeAllHandler } from "@/lib/auth/logout";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

// Forwards to Better Auth's /revoke-sessions. Contract: docs/LOGOUT.md.
export const POST = withRequestLogging(
  "/api/sgauth/sessions/revoke-all",
  createRevokeAllHandler({ auth }),
  logger,
);
