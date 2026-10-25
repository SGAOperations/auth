import { auth } from "@/lib/auth/config";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { consumeRedirect, isResolvedRedirect } from "@/lib/redirect/consume";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import { createVerifyEmailConsumer } from "@/lib/token-links/verify-email";

export const runtime = "nodejs";

// POST only: there is no GET export, so Next answers GET and HEAD with 405.
export const POST = createTokenActionHandler({
  action: "verify-email",
  consume: createVerifyEmailConsumer({
    auth,
    db: prisma,
    secret: toAuthSettings(env).secret,
    resolveRedirect: consumeRedirect,
  }),
  limit: (ip) => checkRateLimit("tokenLink", { ip }),
  allowRedirect: isResolvedRedirect,
  log: logger,
});
