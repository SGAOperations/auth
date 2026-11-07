import "server-only";
import { randomBytes } from "node:crypto";
import { audit, withAuditTransaction } from "@/lib/audit";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import {
  consumeSlackLinkToken,
  linkSlackIdentity,
  unlinkSlackIdentity,
} from "@/lib/slack/identity";
import {
  SLACK_CALLBACK_PATH,
  completeSlackOpenId,
  slackAuthorizeUrl,
  type SlackOpenIdConfig,
} from "@/lib/slack/openid";
import {
  OAUTH_STATE_PREFIX,
  consumeOAuthState,
  createOAuthState,
} from "@/lib/slack/oauth-state";
import {
  revokeTakenToken,
  takeSlackUserToken,
  type TakenSlackToken,
} from "@/lib/slack/user-token";

// The signed-in user's side of Slack linking (#313, #314): confirming a link
// token a product DM'd them, Connect Slack, and unlinking. Each change writes
// its audit row in the same transaction. A change that ends the user's right to
// their Slack title token (#358) deletes and audits it there too, and revokes it
// at Slack after the commit.

const baseURL = toAuthSettings(env).baseURL;

/** The OpenID settings, or null when Connect Slack is not configured. */
export function slackOpenIdConfig(): SlackOpenIdConfig | null {
  if (!env.SLACK_CLIENT_ID || !env.SLACK_CLIENT_SECRET || !env.SLACK_TEAM_ID) {
    return null;
  }
  return {
    clientId: env.SLACK_CLIENT_ID,
    clientSecret: env.SLACK_CLIENT_SECRET,
    teamId: env.SLACK_TEAM_ID,
    redirectUri: new URL(SLACK_CALLBACK_PATH, baseURL).toString(),
  };
}

export type SlackLinkOutcome =
  | "linked"
  | "unchanged"
  | "taken"
  | "invalid_token"
  | "not_configured"
  | "failed"
  | "wrong_team";

class TakenError extends Error {}

/**
 * Links the Slack account a product's link token names to the signed-in user.
 * A Slack account linked to someone else is refused, and the token stays
 * unused, so the other person can unlink and the link still works.
 */
export async function confirmSlackLinkToken(
  userId: string,
  token: string,
): Promise<SlackLinkOutcome> {
  const taken: TakenSlackToken[] = [];
  try {
    const outcome = await withAuditTransaction(prisma, async (tx) => {
      const view = await consumeSlackLinkToken(tx, token);
      if (!view) return "invalid_token";
      const result = await linkSlackIdentity(tx, {
        userId,
        slackTeamId: view.slackTeamId,
        slackUserId: view.slackUserId,
        linkedVia: "SLACK_COMMAND",
        productId: view.productId,
      });
      if (result.status === "taken") throw new TakenError();
      if (result.status === "unchanged") return "unchanged";
      // The token belongs to the Slack account this link replaces.
      if (result.replaced !== null) {
        const token = await takeSlackUserToken(tx, userId, "relinked", {
          actor: { actorType: "USER", actorUserId: userId },
        });
        if (token) taken.push(token);
      }
      const product = await tx.product.findUnique({
        where: { id: view.productId },
        select: { slug: true },
      });
      await audit({
        type: "SLACK_LINKED",
        actorType: "USER",
        actorUserId: userId,
        targetType: "USER",
        targetId: userId,
        metadata: {
          via: "slack_command",
          slackTeamId: view.slackTeamId,
          slackUserId: view.slackUserId,
          ...(product ? { productSlug: product.slug } : {}),
          replaced: result.replaced !== null,
        },
      });
      return "linked";
    });
    for (const token of taken) await revokeTakenToken(token);
    return outcome;
  } catch (err) {
    // Rolls the token's consumption back with everything else.
    if (err instanceof TakenError) return "taken";
    throw err;
  }
}

/**
 * Removes the signed-in user's Slack link, and with it their Slack title token.
 * False when there was no link.
 */
export async function unlinkOwnSlack(userId: string): Promise<boolean> {
  const taken: TakenSlackToken[] = [];
  const removedLink = await withAuditTransaction(prisma, async (tx) => {
    const removed = await unlinkSlackIdentity(tx, userId);
    if (!removed) return false;
    const token = await takeSlackUserToken(tx, userId, "unlinked", {
      actor: { actorType: "USER", actorUserId: userId },
    });
    if (token) taken.push(token);
    await audit({
      type: "SLACK_UNLINKED",
      actorType: "USER",
      actorUserId: userId,
      targetType: "USER",
      targetId: userId,
      metadata: removed,
    });
    return true;
  });
  for (const token of taken) await revokeTakenToken(token);
  return removedLink;
}

/**
 * Starts Connect Slack: stores the nonce against a hash of the state, for this
 * user, and returns Slack's URL and the state for the browser-binding cookie.
 */
export async function startSlackConnect(
  userId: string,
  now: Date = new Date(),
): Promise<{ url: string; state: string } | null> {
  const config = slackOpenIdConfig();
  if (!config) return null;
  const nonce = randomBytes(32).toString("base64url");
  const state = await createOAuthState(
    OAUTH_STATE_PREFIX.connect,
    userId,
    { nonce },
    now,
  );
  return { url: slackAuthorizeUrl(config, state, nonce), state };
}

/**
 * Finishes Connect Slack. The state must match the cookie of the browser that
 * started it and belong to the signed-in user; it is single-use. Then Slack's
 * ID token decides which Slack account is linked.
 */
export async function finishSlackConnect(
  userId: string,
  input: { state: string; cookieState: string | undefined; code: string },
  now: Date = new Date(),
): Promise<SlackLinkOutcome> {
  const config = slackOpenIdConfig();
  if (!config) return "not_configured";
  const stored = await consumeOAuthState(
    OAUTH_STATE_PREFIX.connect,
    input.state,
    input.cookieState,
    userId,
    now,
  );
  if (!stored || typeof stored.nonce !== "string") return "failed";

  const verified = await completeSlackOpenId(config, {
    code: input.code,
    nonce: stored.nonce,
  });
  if (!verified.ok) {
    return verified.reason === "wrong_team" ? "wrong_team" : "failed";
  }

  const taken: TakenSlackToken[] = [];
  const outcome = await withAuditTransaction(prisma, async (tx) => {
    const result = await linkSlackIdentity(tx, {
      userId,
      slackTeamId: verified.slackTeamId,
      slackUserId: verified.slackUserId,
      linkedVia: "SLACK_OPENID",
    });
    if (result.status !== "linked") return result.status;
    // The token belongs to the Slack account this link replaces.
    if (result.replaced !== null) {
      const token = await takeSlackUserToken(tx, userId, "relinked", {
        actor: { actorType: "USER", actorUserId: userId },
      });
      if (token) taken.push(token);
    }
    await audit({
      type: "SLACK_LINKED",
      actorType: "USER",
      actorUserId: userId,
      targetType: "USER",
      targetId: userId,
      metadata: {
        via: "slack_openid",
        slackTeamId: verified.slackTeamId,
        slackUserId: verified.slackUserId,
        replaced: result.replaced !== null,
      },
    });
    return "linked";
  });
  for (const token of taken) await revokeTakenToken(token);
  return outcome;
}

/** The signed-in user's Slack link, for the account page. */
export function getOwnSlackIdentity(userId: string) {
  return prisma.slackIdentity.findUnique({
    where: { userId },
    select: { slackTeamId: true, slackUserId: true, linkedAt: true },
  });
}
