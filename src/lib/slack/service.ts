import "server-only";
import { createHash, randomBytes, timingSafeEqual } from "node:crypto";
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

// The signed-in user's side of Slack linking (#313, #314): confirming a link
// token a product DM'd them, Connect Slack, and unlinking. Each change writes
// its audit row in the same transaction.

const baseURL = toAuthSettings(env).baseURL;

/** Ten minutes to finish signing in to Slack. */
const OPENID_STATE_TTL_MS = 10 * 60 * 1000;
const OPENID_IDENTIFIER_PREFIX = "slack-openid:";

export const SLACK_STATE_COOKIE_MAX_AGE = OPENID_STATE_TTL_MS / 1000;

/** The cookie that binds a Connect Slack flow to the browser that started it. */
export const slackStateCookieName = (): string =>
  new URL(baseURL).protocol === "https:"
    ? "__Host-sgauth.slack-state"
    : "sgauth.slack-state";

export const slackStateCookieSecure = (): boolean =>
  new URL(baseURL).protocol === "https:";

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

const sha256Hex = (value: string) =>
  createHash("sha256").update(value).digest("hex");

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
  try {
    return await withAuditTransaction(prisma, async (tx) => {
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
  } catch (err) {
    // Rolls the token's consumption back with everything else.
    if (err instanceof TakenError) return "taken";
    throw err;
  }
}

/** Removes the signed-in user's Slack link. False when there was none. */
export async function unlinkOwnSlack(userId: string): Promise<boolean> {
  return withAuditTransaction(prisma, async (tx) => {
    const removed = await unlinkSlackIdentity(tx, userId);
    if (!removed) return false;
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
  const state = randomBytes(32).toString("base64url");
  const nonce = randomBytes(32).toString("base64url");
  await prisma.verification.create({
    data: {
      identifier: `${OPENID_IDENTIFIER_PREFIX}${sha256Hex(state)}`,
      value: JSON.stringify({ userId, nonce }),
      expiresAt: new Date(now.getTime() + OPENID_STATE_TTL_MS),
    },
  });
  return { url: slackAuthorizeUrl(config, state, nonce), state };
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(sha256Hex(a), "hex");
  const right = Buffer.from(sha256Hex(b), "hex");
  return timingSafeEqual(left, right);
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
  if (!input.cookieState || !sameString(input.state, input.cookieState)) {
    return "failed";
  }

  const identifier = `${OPENID_IDENTIFIER_PREFIX}${sha256Hex(input.state)}`;
  const row = await prisma.verification.findFirst({
    where: { identifier, expiresAt: { gt: now } },
    select: { id: true, value: true },
  });
  if (!row) return "failed";
  // Single use, whatever happens next.
  const { count } = await prisma.verification.deleteMany({
    where: { id: row.id },
  });
  if (count !== 1) return "failed";

  let stored: { userId?: unknown; nonce?: unknown };
  try {
    stored = JSON.parse(row.value);
  } catch {
    return "failed";
  }
  if (stored.userId !== userId || typeof stored.nonce !== "string") {
    return "failed";
  }

  const verified = await completeSlackOpenId(config, {
    code: input.code,
    nonce: stored.nonce,
  });
  if (!verified.ok) {
    return verified.reason === "wrong_team" ? "wrong_team" : "failed";
  }

  return withAuditTransaction(prisma, async (tx) => {
    const result = await linkSlackIdentity(tx, {
      userId,
      slackTeamId: verified.slackTeamId,
      slackUserId: verified.slackUserId,
      linkedVia: "SLACK_OPENID",
    });
    if (result.status !== "linked") return result.status;
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
}

/** The signed-in user's Slack link, for the account page. */
export function getOwnSlackIdentity(userId: string) {
  return prisma.slackIdentity.findUnique({
    where: { userId },
    select: { slackTeamId: true, slackUserId: true, linkedAt: true },
  });
}
