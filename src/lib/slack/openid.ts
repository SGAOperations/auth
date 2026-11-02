import { createRemoteJWKSet, jwtVerify, type JWTVerifyGetKey } from "jose";

// Connect Slack from the account page (#314): Slack's OpenID Connect flow, used
// to prove which Slack account a signed-in user holds. It links; it never signs
// anyone in to SGAuth. Pure apart from `fetch` and the JWKS, which are
// injectable, so every check is unit-testable.

export const SLACK_ISSUER = "https://slack.com";
export const SLACK_AUTHORIZE_URL = "https://slack.com/openid/connect/authorize";
export const SLACK_TOKEN_URL = "https://slack.com/api/openid.connect.token";
export const SLACK_JWKS_URL = "https://slack.com/openid/connect/keys";

/** The callback path registered as the Slack app's redirect URL. */
export const SLACK_CALLBACK_PATH = "/account/slack/callback";

export interface SlackOpenIdConfig {
  clientId: string;
  clientSecret: string;
  teamId: string;
  redirectUri: string;
}

/** The URL that starts the flow. `team` makes Slack offer only the SGA workspace. */
export function slackAuthorizeUrl(
  config: Pick<SlackOpenIdConfig, "clientId" | "teamId" | "redirectUri">,
  state: string,
  nonce: string,
): string {
  const url = new URL(SLACK_AUTHORIZE_URL);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid");
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.redirectUri);
  url.searchParams.set("state", state);
  url.searchParams.set("nonce", nonce);
  url.searchParams.set("team", config.teamId);
  return url.toString();
}

export type SlackOpenIdFailure =
  | "token_exchange_failed"
  | "invalid_id_token"
  | "wrong_team";

export type SlackOpenIdResult =
  | { ok: true; slackTeamId: string; slackUserId: string }
  | { ok: false; reason: SlackOpenIdFailure };

let defaultJwks: JWTVerifyGetKey | null = null;
function slackJwks(): JWTVerifyGetKey {
  defaultJwks ??= createRemoteJWKSet(new URL(SLACK_JWKS_URL));
  return defaultJwks;
}

/**
 * Exchanges the code and verifies the ID token: Slack's signature, issuer,
 * audience, expiry and the nonce bound to this browser, then the workspace.
 * Never logs or returns the code, the access token or the ID token.
 */
export async function completeSlackOpenId(
  config: SlackOpenIdConfig,
  input: { code: string; nonce: string },
  deps: { fetch?: typeof fetch; jwks?: JWTVerifyGetKey } = {},
): Promise<SlackOpenIdResult> {
  const doFetch = deps.fetch ?? fetch;
  let idToken: string;
  try {
    const response = await doFetch(SLACK_TOKEN_URL, {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: config.clientId,
        client_secret: config.clientSecret,
        code: input.code,
        redirect_uri: config.redirectUri,
      }),
      signal: AbortSignal.timeout(10_000),
    });
    const body: unknown = await response.json();
    if (
      !response.ok ||
      typeof body !== "object" ||
      body === null ||
      !("ok" in body) ||
      body.ok !== true ||
      !("id_token" in body) ||
      typeof body.id_token !== "string"
    ) {
      return { ok: false, reason: "token_exchange_failed" };
    }
    idToken = body.id_token;
  } catch {
    return { ok: false, reason: "token_exchange_failed" };
  }

  let claims: Record<string, unknown>;
  try {
    const verified = await jwtVerify(idToken, deps.jwks ?? slackJwks(), {
      issuer: SLACK_ISSUER,
      audience: config.clientId,
    });
    claims = verified.payload;
  } catch {
    return { ok: false, reason: "invalid_id_token" };
  }

  const slackUserId = claims["https://slack.com/user_id"];
  const slackTeamId = claims["https://slack.com/team_id"];
  if (
    claims.nonce !== input.nonce ||
    typeof slackUserId !== "string" ||
    typeof slackTeamId !== "string"
  ) {
    return { ok: false, reason: "invalid_id_token" };
  }
  if (slackTeamId !== config.teamId) return { ok: false, reason: "wrong_team" };
  return { ok: true, slackTeamId, slackUserId };
}
