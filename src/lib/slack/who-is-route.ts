import "server-only";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { prisma } from "@/lib/prisma";
import { SLACK_ACCOUNT_PATH } from "@/lib/slack/links";
import { createWhoIsHandler } from "@/lib/slack/who-is";
import { loadWhoIs } from "@/lib/slack/who-is-lookup";

// `POST /api/slack/commands/who-is` (#349), wired to env, the database and the
// logger. The logic is who-is.ts; the reads are who-is-lookup.ts.

export const whoIsRoute = withRequestLogging(
  "/api/slack/commands/who-is",
  createWhoIsHandler({
    signingSecret: env.SLACK_SIGNING_SECRET,
    teamId: env.SLACK_TEAM_ID,
    accountUrl: new URL(
      SLACK_ACCOUNT_PATH,
      toAuthSettings(env).baseURL,
    ).toString(),
    lookup: (input) => loadWhoIs(prisma, input),
    log: logger,
  }),
  logger,
);
