import "server-only";
import { toAuthSettings } from "@/lib/auth/settings";
import { createEmailChangeService } from "@/lib/email-change/service";
import { mailer } from "@/lib/email/server";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

export const emailChangeService = createEmailChangeService({
  prisma,
  mailer,
  linkOrigin: new URL(toAuthSettings(env).baseURL).origin,
  log: logger,
  now: () => new Date(),
});
