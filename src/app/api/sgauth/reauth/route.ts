import { auth } from "@/lib/auth/config";
import { createReauthRoute } from "@/lib/auth/reauth-route";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { limitRequest } from "@/lib/rate-limit/server";

export const runtime = "nodejs";

// The credential check is Better Auth's server-only `sgauthReauthenticate`,
// which is never served at /api/auth. Contract: docs/REAUTH.md.
export const POST = withRequestLogging(
  "/api/sgauth/reauth",
  createReauthRoute({
    getSession: (headers) => auth.api.getSession({ headers }),
    limit: (userId) => limitRequest("reauth", userId),
    reauthenticate: (input) =>
      auth.api.sgauthReauthenticate({ ...input, asResponse: true }),
  }),
  logger,
);
