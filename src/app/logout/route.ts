import { env } from "@/lib/env";
import { auth } from "@/lib/auth/config";
import { createLogoutHandler } from "@/lib/auth/logout";
import { toAuthSettings } from "@/lib/auth/settings";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { isAllowedRedirect } from "@/lib/products";

export const runtime = "nodejs";

const settings = toAuthSettings(env);

// GET only, so HEAD and POST get 405. Contract: docs/LOGOUT.md.
export const GET = withRequestLogging(
  "/logout",
  createLogoutHandler({
    auth,
    sgauthOrigin: new URL(settings.baseURL).origin,
    allowHttpProducts: settings.sgauthEnv === "local",
    isAllowedRedirect,
    log: logger,
  }),
  logger,
);
