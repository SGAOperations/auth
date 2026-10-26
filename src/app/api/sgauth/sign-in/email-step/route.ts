import { after } from "next/server";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createSetPasswordRequestHandler } from "@/lib/set-password/request-handler";
import { setPasswordService } from "@/lib/set-password/server";

export const runtime = "nodejs";

// The login page's email step. It answers every well-formed address the same,
// and sends a set-password link, after the response, only to an ACTIVE account
// with no password. The audit row is written by the service.
export const POST = createSetPasswordRequestHandler({
  mode: "json",
  service: setPasswordService,
  limit: (ids) => checkRateLimit("setPasswordRequest", ids),
  defer: after,
  log: logger,
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
});
