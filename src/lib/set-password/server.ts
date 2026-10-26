import "server-only";
import { toAuthSettings } from "@/lib/auth/settings";
import { mailer } from "@/lib/email/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { checkRateLimit } from "@/lib/rate-limit/server";
import { createSetPasswordService } from "@/lib/set-password/service";

// Must not import `@/lib/auth/config`, which imports this module for the
// self-sign-up trigger.
export const setPasswordService = createSetPasswordService({
  prisma,
  mailer,
  limit: (policy, userId) => checkRateLimit(policy, { user: userId }),
  linkOrigin: new URL(toAuthSettings(env).baseURL).origin,
  log: logger,
  now: () => new Date(),
});
