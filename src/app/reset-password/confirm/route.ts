import { auth } from "@/lib/auth/config";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import {
  createResetPasswordConsumer,
  resetPasswordFields,
} from "@/lib/token-links/reset-password";

export const runtime = "nodejs";

// POST only: there is no GET export, so Next answers GET and HEAD with 405.
// Holding the token is the authority, so the request is anonymous; the handler
// enforces same-origin and the tokenLink IP limit. PASSWORD_RESET is written by
// Better Auth's onPasswordReset hook.
export const POST = createTokenActionHandler({
  action: "reset-password",
  fields: resetPasswordFields,
  consume: createResetPasswordConsumer({ auth }),
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  log: logger,
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
});
