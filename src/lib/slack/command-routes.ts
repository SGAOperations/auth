import "server-only";
import { accessReplyText } from "@/lib/access-requests/replies";
import { submitAccessRequest } from "@/lib/access-requests/submit";
import { runAfterResponse } from "@/lib/auth/background";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { createSlackCommandHandler } from "@/lib/slack/command-handler";

// The slash-command route Slack calls directly (#342), wired to the database,
// the environment and the logger. The only credential is Slack's signature.

const accountUrl = new URL("/account", toAuthSettings(env).baseURL).toString();

const FOLLOW_UP_TIMEOUT_MS = 10_000;

export const slackAccessCommandRoute = withRequestLogging(
  "/api/slack/commands/access",
  createSlackCommandHandler({
    name: "slack_command.access",
    command: "/access",
    signingSecret: env.SLACK_SIGNING_SECRET,
    teamId: env.SLACK_TEAM_ID,
    run: async (input) => {
      const outcome = await submitAccessRequest(input);
      return {
        status: outcome.status,
        text: accessReplyText(outcome, { accountUrl }),
      };
    },
    defer: runAfterResponse,
    // Never throws: a lost follow-up leaves the "Submitting..." ack in place.
    postFollowUp: async (responseUrl, reply) => {
      try {
        const response = await fetch(responseUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(reply),
          signal: AbortSignal.timeout(FOLLOW_UP_TIMEOUT_MS),
        });
        if (!response.ok) {
          logger.warn("slack_command.follow_up_failed", {
            status: response.status,
          });
        }
      } catch {
        logger.warn("slack_command.follow_up_failed", { status: "network" });
      }
    },
    log: logger,
  }),
  logger,
);
