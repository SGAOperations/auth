import "server-only";
import { audit, withAuditTransaction } from "@/lib/audit";
import { toAuthSettings } from "@/lib/auth/settings";
import { canGrantSlackProfileAccess } from "@/lib/authz";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { linkSlackIdentity } from "@/lib/slack/identity";
import {
  OAUTH_STATE_PREFIX,
  consumeOAuthState,
  createOAuthState,
} from "@/lib/slack/oauth-state";
import {
  SLACK_CONSENT_CALLBACK_PATH,
  exchangeSlackConsentCode,
  revokeSlackToken,
  slackConsentAuthorizeUrl,
  type SlackConsentConfig,
} from "@/lib/slack/oauth-v2";
import type { SlackResult } from "@/lib/slack/result";
import { slackOpenIdConfig } from "@/lib/slack/service";
import {
  decryptSlackToken,
  revokeTakenToken,
  storeSlackUserToken,
  takeSlackUserToken,
  type TakenSlackToken,
} from "@/lib/slack/user-token";

// Allow Slack title updates (#358): the user's consent, in Slack's OAuth v2
// install, for SGAuth to edit their Slack profile. Only leaders are asked. The
// token is stored encrypted (user-token.ts) and is never used here: the sync
// and the clear-on-loss job do the profile writes.

const baseURL = toAuthSettings(env).baseURL;

interface Deps {
  fetch?: typeof fetch;
}

/** The consent's Slack settings, or null when Slack is not configured. */
function slackConsentConfig(): SlackConsentConfig | null {
  const config = slackOpenIdConfig();
  if (!config) return null;
  return {
    ...config,
    redirectUri: new URL(SLACK_CONSENT_CALLBACK_PATH, baseURL).toString(),
  };
}

/** The user's status and whether they hold an active leadership position. */
async function loadGrantor(db: Pick<typeof prisma, "user">, userId: string) {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      id: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      status: true,
      positions: {
        where: { position: { deletedAt: null } },
        select: { position: { select: { isLeadership: true } } },
      },
    },
  });
  if (!user) return null;
  return {
    subject: user,
    isLeadership: user.positions.some(({ position }) => position.isLeadership),
  };
}

async function mayGrant(userId: string): Promise<boolean> {
  const grantor = await loadGrantor(prisma, userId);
  return (
    grantor !== null &&
    canGrantSlackProfileAccess(grantor.subject, grantor).allowed
  );
}

export type StartProfileAccessResult =
  | { url: string; state: string }
  | "not_configured"
  | "not_leadership";

/** Starts the consent: stores the state for this user and returns Slack's URL. */
export async function startSlackProfileAccess(
  userId: string,
  now: Date = new Date(),
): Promise<StartProfileAccessResult> {
  const config = slackConsentConfig();
  if (!config) return "not_configured";
  if (!(await mayGrant(userId))) return "not_leadership";
  const state = await createOAuthState(
    OAUTH_STATE_PREFIX.consent,
    userId,
    {},
    now,
  );
  return { url: slackConsentAuthorizeUrl(config, state), state };
}

export type FinishProfileAccessOutcome = Extract<
  SlackResult,
  | "title_updates_allowed"
  | "not_configured"
  | "failed"
  | "wrong_team"
  | "taken"
  | "different_account"
  | "not_leadership"
  | "missing_scope"
>;

/** Revokes a token SGAuth received and will not keep. Best effort; never throws. */
async function discard(
  token: string | undefined,
  reason: string,
  deps: Deps,
): Promise<void> {
  if (!token) return;
  logger.warn("slack_token_discarded", { reason });
  await revokeSlackToken(token, { fetch: deps.fetch });
}

/**
 * Finishes the consent. The state must match this browser's cookie and belong to
 * the signed-in user, and is single-use. Then the exchange (an HTTP call, so
 * before any transaction), a leadership re-check, and one transaction that
 * links the Slack account when the user has none, stores the token and audits
 * it. Every token received but not stored is revoked.
 */
export async function finishSlackProfileAccess(
  userId: string,
  input: { state: string; cookieState: string | undefined; code: string },
  deps: Deps = {},
  now: Date = new Date(),
): Promise<FinishProfileAccessOutcome> {
  const config = slackConsentConfig();
  if (!config) return "not_configured";
  const stored = await consumeOAuthState(
    OAUTH_STATE_PREFIX.consent,
    input.state,
    input.cookieState,
    userId,
    now,
  );
  if (!stored) return "failed";

  const exchanged = await exchangeSlackConsentCode(config, input.code, deps);
  if (!exchanged.ok) {
    await discard(exchanged.token, exchanged.reason, deps);
    if (exchanged.reason === "wrong_team") return "wrong_team";
    if (exchanged.reason === "missing_scope") return "missing_scope";
    return "failed";
  }

  if (!(await mayGrant(userId))) {
    await discard(exchanged.token, "not_leadership", deps);
    return "not_leadership";
  }

  const actor = { actorType: "USER", actorUserId: userId } as const;
  const result = await withAuditTransaction(prisma, async (tx) => {
    // Lock the user row, then re-check leadership and status here, so a
    // deactivation or position change that lands after the pre-check above
    // cannot leave a token stored for someone who may no longer grant it.
    await tx.$queryRaw`SELECT id FROM "User" WHERE id = ${userId} FOR UPDATE`;
    const grantor = await loadGrantor(tx, userId);
    if (
      grantor === null ||
      !canGrantSlackProfileAccess(grantor.subject, grantor).allowed
    ) {
      return { outcome: "not_leadership" } as const;
    }

    const identity = await tx.slackIdentity.findUnique({
      where: { userId },
      select: { slackTeamId: true, slackUserId: true },
    });
    if (!identity) {
      const linked = await linkSlackIdentity(tx, {
        userId,
        slackTeamId: exchanged.slackTeamId,
        slackUserId: exchanged.slackUserId,
        linkedVia: "SLACK_OAUTH",
      });
      if (linked.status === "taken") return { outcome: "taken" } as const;
      await audit({
        type: "SLACK_LINKED",
        ...actor,
        targetType: "USER",
        targetId: userId,
        metadata: {
          via: "slack_oauth",
          slackTeamId: exchanged.slackTeamId,
          slackUserId: exchanged.slackUserId,
          replaced: false,
        },
      });
    } else if (
      identity.slackTeamId !== exchanged.slackTeamId ||
      identity.slackUserId !== exchanged.slackUserId
    ) {
      return { outcome: "different_account" } as const;
    }

    const { previousCiphertext } = await storeSlackUserToken(tx, {
      userId,
      slackTeamId: exchanged.slackTeamId,
      slackUserId: exchanged.slackUserId,
      scopes: exchanged.scopes,
      token: exchanged.token,
    });
    await audit({
      type: "SLACK_TOKEN_GRANTED",
      ...actor,
      targetType: "USER",
      targetId: userId,
      metadata: {
        slackTeamId: exchanged.slackTeamId,
        slackUserId: exchanged.slackUserId,
        scopes: exchanged.scopes,
        replaced: previousCiphertext !== null,
      },
    });
    return { outcome: "title_updates_allowed", previousCiphertext } as const;
  });

  if (result.outcome !== "title_updates_allowed") {
    await discard(exchanged.token, result.outcome, deps);
    return result.outcome;
  }

  // Slack may hand back the token it already issued, and revoking that would
  // kill the grant just stored. Only a different token is revoked. A grant that
  // replaces another is recorded as `withdrawn`, the nearest reason.
  if (result.previousCiphertext !== null) {
    const previous = await decryptSlackToken(result.previousCiphertext).catch(
      () => null,
    );
    if (previous !== exchanged.token) {
      await revokeTakenToken(
        {
          userId,
          ciphertext: result.previousCiphertext,
          reason: "withdrawn",
          actor,
          detached: false,
        },
        { revoke: (token) => revokeSlackToken(token, { fetch: deps.fetch }) },
      );
    }
  }
  return "title_updates_allowed";
}

/**
 * The user takes back their consent: the token is deleted and audited in one
 * transaction and revoked at Slack after it. False when there was none.
 */
export async function withdrawSlackProfileAccess(
  userId: string,
  deps: Deps = {},
): Promise<boolean> {
  const taken: TakenSlackToken[] = [];
  await withAuditTransaction(prisma, async (tx) => {
    const token = await takeSlackUserToken(tx, userId, "withdrawn", {
      actor: { actorType: "USER", actorUserId: userId },
    });
    if (token) taken.push(token);
  });
  for (const token of taken) {
    await revokeTakenToken(token, {
      revoke: (value) => revokeSlackToken(value, { fetch: deps.fetch }),
    });
  }
  return taken.length > 0;
}

/** When the signed-in user granted title updates, or null when they have not. */
export function getOwnSlackProfileAccess(userId: string) {
  return prisma.slackUserToken.findUnique({
    where: { userId },
    select: { grantedAt: true },
  });
}
