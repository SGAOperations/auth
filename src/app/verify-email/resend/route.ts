import { auth } from "@/lib/auth/config";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import { createResendVerifyEmailConsumer } from "@/lib/token-links/verify-email";

export const runtime = "nodejs";

// POST only, like the confirm route. The same bucket as
// POST /api/auth/send-verification-email: 3 per address per hour.
export const POST = createTokenActionHandler({
  action: "verify-email",
  consume: createResendVerifyEmailConsumer({
    auth,
    secret: toAuthSettings(env).secret,
    limit: async (email) =>
      (await checkRateLimit("verificationResend", { email })).allowed,
  }),
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  log: logger,
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
});
