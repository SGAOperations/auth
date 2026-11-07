import { z } from "zod";
import { slackUserIdSchema } from "@/lib/slack/ids";

// The Slack title-update consent (#358): Slack's OAuth v2 install with user
// scopes only, which returns the xoxp- token that users.profile.set needs. It is
// separate from Sign in with Slack (openid.ts), which only proves who someone
// is. Pure apart from `fetch`, which is injectable, so every check is
// unit-testable. Never logs or returns the code or a token, except `token` in a
// result that carries one so the caller can store or revoke it.

export const SLACK_CONSENT_AUTHORIZE_URL =
  "https://slack.com/oauth/v2/authorize";
export const SLACK_OAUTH_ACCESS_URL = "https://slack.com/api/oauth.v2.access";
export const SLACK_REVOKE_URL = "https://slack.com/api/auth.revoke";

/**
 * The user scopes SGAuth asks for, and only these. Write is what the title sync
 * needs; read is asked for now so a later feature does not need a second
 * consent. A grant is accepted only when both come back.
 */
export const SLACK_PROFILE_WRITE_SCOPE = "users.profile:write";
export const SLACK_PROFILE_READ_SCOPE = "users.profile:read";
export const SLACK_CONSENT_SCOPES = [
  SLACK_PROFILE_WRITE_SCOPE,
  SLACK_PROFILE_READ_SCOPE,
] as const;

/** The callback path registered as a redirect URL of the Slack app. */
export const SLACK_CONSENT_CALLBACK_PATH =
  "/account/slack/profile-access/callback";

const TIMEOUT_MS = 10_000;

export interface SlackConsentConfig {
  clientId: string;
  clientSecret: string;
  teamId: string;
  redirectUri: string;
}

/**
 * The URL that starts the consent. `user_scope` only: with no `scope`, Slack
 * issues no bot token. `team` is a hint, so the team is checked again on the
 * exchange.
 */
export function slackConsentAuthorizeUrl(
  config: Pick<SlackConsentConfig, "clientId" | "teamId" | "redirectUri">,
  state: string,
): string {
  const url = new URL(SLACK_CONSENT_AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("user_scope", SLACK_CONSENT_SCOPES.join(","));
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("team", config.teamId);
  return url.toString();
}

export type SlackConsentFailure =
  /** Slack refused the code, answered with an error status, or was unreachable. */
  | "exchange_failed"
  | "wrong_team"
  /** The response lacks a field the grant depends on, or one has the wrong shape. */
  | "invalid_response"
  | "missing_scope"
  /** Token rotation is on in the Slack app. SGAuth does not refresh tokens. */
  | "token_rotation_enabled";

export type SlackConsentResult =
  | {
      ok: true;
      slackTeamId: string;
      slackUserId: string;
      token: string;
      scopes: string[];
    }
  /** `token` is any token Slack did send, so the caller can revoke it. */
  | { ok: false; reason: SlackConsentFailure; token?: string };

const exchangeBody = z.object({
  ok: z.literal(true),
  team: z.object({ id: z.string() }).nullish(),
  authed_user: z.object({
    id: z.string(),
    scope: z.string().optional(),
    access_token: z.string(),
    token_type: z.string().optional(),
    refresh_token: z.string().optional(),
    expires_in: z.number().optional(),
  }),
  refresh_token: z.string().optional(),
  expires_in: z.number().optional(),
});

const okFlag = z.object({ ok: z.literal(true) });

/** Whatever token a response carries, for revoking it when it is not kept. */
const looseToken = z.object({
  authed_user: z.object({ access_token: z.string() }),
});

/** Exchanges the code and accepts the response only if it is the grant SGAuth asked for. */
export async function exchangeSlackConsentCode(
  config: SlackConsentConfig,
  code: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<SlackConsentResult> {
  const doFetch = deps.fetch ?? fetch;
  let body: unknown;
  try {
    const response = await doFetch(SLACK_OAUTH_ACCESS_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    body = await response.json();
    if (!response.ok) return { ok: false, reason: "exchange_failed" };
  } catch {
    return { ok: false, reason: "exchange_failed" };
  }

  const parsed = exchangeBody.safeParse(body);
  if (!parsed.success) {
    const answeredOk = okFlag.safeParse(body).success;
    const held = looseToken.safeParse(body);
    return {
      ok: false,
      reason: answeredOk ? "invalid_response" : "exchange_failed",
      ...(held.success ? { token: held.data.authed_user.access_token } : {}),
    };
  }

  const { team, authed_user: user } = parsed.data;
  const token = user.access_token;
  const refuse = (reason: SlackConsentFailure): SlackConsentResult => ({
    ok: false,
    reason,
    token,
  });

  if (
    user.refresh_token !== undefined ||
    user.expires_in !== undefined ||
    parsed.data.refresh_token !== undefined ||
    parsed.data.expires_in !== undefined
  ) {
    return refuse("token_rotation_enabled");
  }
  if (team?.id !== config.teamId) return refuse("wrong_team");
  if (
    !slackUserIdSchema.safeParse(user.id).success ||
    user.token_type !== "user" ||
    !token.startsWith("xoxp-")
  ) {
    return refuse("invalid_response");
  }
  const scopes = (user.scope ?? "").split(",").filter(Boolean);
  if (!SLACK_CONSENT_SCOPES.every((scope) => scopes.includes(scope))) {
    return refuse("missing_scope");
  }
  return {
    ok: true,
    slackTeamId: team.id,
    slackUserId: user.id,
    token,
    scopes,
  };
}

/** Slack answers these when the token is already dead, so there is nothing to revoke. */
const ALREADY_INVALID = new Set([
  "invalid_auth",
  "token_revoked",
  "token_expired",
  "account_inactive",
  "not_authed",
]);

export type SlackRevokeResult =
  | "revoked"
  | "already_invalid"
  /** `failed` is Slack's error code, or `network`. */
  | { failed: string };

/** Revokes a token at Slack with `auth.revoke`. Never throws. */
export async function revokeSlackToken(
  token: string,
  deps: { fetch?: typeof fetch } = {},
): Promise<SlackRevokeResult> {
  const doFetch = deps.fetch ?? fetch;
  try {
    const response = await doFetch(SLACK_REVOKE_URL, {
      method: "POST",
      headers: { Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null || !("ok" in body)) {
      return { failed: "network" };
    }
    if (body.ok === true) return "revoked";
    const error = "error" in body ? String(body.error) : "unknown";
    return ALREADY_INVALID.has(error) ? "already_invalid" : { failed: error };
  } catch {
    return { failed: "network" };
  }
}
