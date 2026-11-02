import "server-only";
import { z } from "zod";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { prisma } from "@/lib/prisma";
import { createProductApiHandler } from "@/lib/product-api/handler";
import { authenticateProductKey } from "@/lib/product-api-keys";
import { limitRequest } from "@/lib/rate-limit/server";
import {
  SLACK_LOOKUP_MAX_IDS,
  issueSlackLinkToken,
  lookupSlackIdentities,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "@/lib/slack/identity";
import { slackLinkUrl } from "@/lib/slack/links";

// The two routes products call about Slack (#313), wired to the database, the
// key lookup and the rate limiter. The status matrix is product-api/handler.ts.

const baseURL = toAuthSettings(env).baseURL;

const authenticate = (authorization: string | null) =>
  authenticateProductKey(prisma, authorization);
const limit = ({ productId }: { productId: string }) =>
  limitRequest("productApi", productId);

/** A workspace other than SLACK_TEAM_ID, when one is configured. */
const wrongTeam = (slackTeamId: string) =>
  env.SLACK_TEAM_ID !== undefined && slackTeamId !== env.SLACK_TEAM_ID;

const linkTokenBody = z.strictObject({
  slackTeamId: slackTeamIdSchema,
  slackUserId: slackUserIdSchema,
});

const lookupBody = z
  .strictObject({
    slackTeamId: slackTeamIdSchema,
    slackUserIds: z
      .array(slackUserIdSchema)
      .max(SLACK_LOOKUP_MAX_IDS)
      .default([]),
    userIds: z.array(z.uuid()).max(SLACK_LOOKUP_MAX_IDS).default([]),
  })
  .refine((body) => body.slackUserIds.length + body.userIds.length > 0, {
    message: "ask about at least one id",
    path: ["slackUserIds"],
  });

/**
 * `POST /api/products/slack/link-tokens`. The product has verified, from
 * Slack's signed request, that this Slack user is the one asking; SGAuth issues
 * a single-use link for the product to DM them. Writes no audit row: nothing is
 * linked until the person confirms, signed in, and that writes SLACK_LINKED.
 */
export const slackLinkTokenRoute = withRequestLogging(
  "/api/products/slack/link-tokens",
  createProductApiHandler({
    name: "product_api.slack_link_token",
    enabled: true,
    schema: linkTokenBody,
    authenticate,
    limit,
    log: logger,
    run: async (product, input) => {
      if (wrongTeam(input.slackTeamId)) {
        return { status: 403, error: "wrong_team" };
      }
      const { token, expiresAt } = await issueSlackLinkToken(prisma, {
        productId: product.productId,
        ...input,
      });
      return {
        status: 200,
        body: {
          url: slackLinkUrl(baseURL, token),
          expiresAt: expiresAt.toISOString(),
        },
      };
    },
  }),
  logger,
);

/**
 * `POST /api/products/slack/lookup`. Who these Slack users are, and which Slack
 * accounts these SGAuth users linked, in one workspace. Active users only, and
 * ids only: no email or name leaves through here.
 */
export const slackLookupRoute = withRequestLogging(
  "/api/products/slack/lookup",
  createProductApiHandler({
    name: "product_api.slack_lookup",
    enabled: true,
    schema: lookupBody,
    authenticate,
    limit,
    log: logger,
    run: async (_product, input) => {
      if (wrongTeam(input.slackTeamId)) {
        return { status: 403, error: "wrong_team" };
      }
      const identities = await lookupSlackIdentities(prisma, input);
      return { status: 200, body: { identities } };
    },
  }),
  logger,
);
