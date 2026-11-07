import { describe, expect, it, vi } from "vitest";
import {
  SLACK_OAUTH_ACCESS_URL,
  SLACK_REVOKE_URL,
  exchangeSlackConsentCode,
  revokeSlackToken,
  slackConsentAuthorizeUrl,
} from "@/lib/slack/oauth-v2";

const config = {
  clientId: "123.456",
  clientSecret: "shh",
  teamId: "T0SGA",
  redirectUri: "https://auth.example/account/slack/profile-access/callback",
};

// Slack's contract, read on 2026-11-07 from:
// - https://docs.slack.dev/reference/methods/oauth.v2.access
//   (fields `ok`, `team.id`, `authed_user.{id,scope,access_token,token_type}`,
//   form-encoded request, error codes)
// - https://docs.slack.dev/authentication/installing-with-oauth
//   (`user_scope` and `team` on /oauth/v2/authorize; for a user-scope-only
//   install the token is `authed_user.access_token` with `token_type` "user")
// - https://docs.slack.dev/reference/methods/auth.revoke
//   (`token` as a bearer header or form field; `{ok, revoked}`; `invalid_auth`,
//   `token_revoked`, `token_expired`, `account_inactive`, `not_authed`)
// - https://docs.slack.dev/authentication/using-token-rotation
//   (rotation adds `refresh_token` and `expires_in`, is opt-in and cannot be
//   turned off once on)
// Slack's pages carry no complete user-scope-only response, so this fixture is
// that shape assembled from those fields, not a recording. The live response
// is checked by the operator on SGA Testing (the ticket's Testing section).
const FIXTURE = {
  ok: true,
  app_id: "A0118NQPZZC",
  team: { id: "T0SGA" },
  enterprise: null,
  is_enterprise_install: false,
  authed_user: {
    id: "U0ME",
    scope: "users.profile:write,users.profile:read",
    access_token: "xoxp-1111-2222-3333-aaaa",
    token_type: "user",
  },
};

const respond = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => Response.json(body, { status }));

const withUser = (patch: Record<string, unknown>) => ({
  ...FIXTURE,
  authed_user: { ...FIXTURE.authed_user, ...patch },
});

describe("slackConsentAuthorizeUrl", () => {
  it("asks for the profile read and write user scopes only, in the SGA workspace", () => {
    const url = new URL(slackConsentAuthorizeUrl(config, "s1"));
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/oauth/v2/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      client_id: config.clientId,
      user_scope: "users.profile:write,users.profile:read",
      redirect_uri: config.redirectUri,
      state: "s1",
      team: "T0SGA",
    });
    expect(url.searchParams.has("scope")).toBe(false);
  });
});

describe("exchangeSlackConsentCode", () => {
  it("accepts the recorded response and sends a form-encoded request", async () => {
    const fetch = respond(FIXTURE);
    await expect(
      exchangeSlackConsentCode(config, "c1", { fetch }),
    ).resolves.toEqual({
      ok: true,
      slackTeamId: "T0SGA",
      slackUserId: "U0ME",
      token: "xoxp-1111-2222-3333-aaaa",
      scopes: ["users.profile:write", "users.profile:read"],
    });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(SLACK_OAUTH_ACCESS_URL);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: "c1",
      redirect_uri: config.redirectUri,
    });
  });

  it("accepts more scopes as long as both profile ones are among them", async () => {
    const result = await exchangeSlackConsentCode(config, "c1", {
      fetch: respond(
        withUser({
          scope: "users:read,users.profile:read,users.profile:write",
        }),
      ),
    });
    expect(result).toMatchObject({
      ok: true,
      scopes: ["users:read", "users.profile:read", "users.profile:write"],
    });
  });

  it.each([
    ["Slack refuses the code", { ok: false, error: "invalid_code" }, 200],
    ["an HTTP error", FIXTURE, 500],
    ["a body that is not an object", "nope", 200],
  ])("fails the exchange on %s", async (_name, body, status) => {
    await expect(
      exchangeSlackConsentCode(config, "c1", { fetch: respond(body, status) }),
    ).resolves.toEqual({ ok: false, reason: "exchange_failed" });
  });

  it("fails the exchange when Slack is unreachable", async () => {
    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    await expect(
      exchangeSlackConsentCode(config, "c1", { fetch: unreachable }),
    ).resolves.toEqual({ ok: false, reason: "exchange_failed" });
  });

  it("refuses another workspace and hands back the token to revoke", async () => {
    await expect(
      exchangeSlackConsentCode(config, "c1", {
        fetch: respond({ ...FIXTURE, team: { id: "T0OTHER" } }),
      }),
    ).resolves.toEqual({
      ok: false,
      reason: "wrong_team",
      token: FIXTURE.authed_user.access_token,
    });
  });

  it.each([
    ["a bot token type", withUser({ token_type: "bot" })],
    ["no token type", withUser({ token_type: undefined })],
    ["an xoxb- token", withUser({ access_token: "xoxb-1-2-3" })],
    ["a malformed Slack user id", withUser({ id: "u0me" })],
    ["no authed_user token", { ...FIXTURE, authed_user: { id: "U0ME" } }],
  ])("refuses %s", async (_name, body) => {
    const result = await exchangeSlackConsentCode(config, "c1", {
      fetch: respond(body),
    });
    expect(result).toMatchObject({ ok: false, reason: "invalid_response" });
  });

  it.each([
    ["another scope only", "users:read"],
    ["write without read", "users.profile:write"],
    ["read without write", "users.profile:read"],
    ["no scope", undefined],
  ])("refuses a grant missing a profile scope: %s", async (_name, scope) => {
    await expect(
      exchangeSlackConsentCode(config, "c1", {
        fetch: respond(withUser({ scope })),
      }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "missing_scope",
      token: FIXTURE.authed_user.access_token,
    });
  });

  it.each([
    ["a refresh token", withUser({ refresh_token: "xoxe-1-abc" })],
    ["an expiry", withUser({ expires_in: 43200 })],
    ["a top-level refresh token", { ...FIXTURE, refresh_token: "xoxe-1-abc" }],
    ["a top-level expiry", { ...FIXTURE, expires_in: 43200 }],
  ])("refuses a rotating token: %s", async (_name, body) => {
    await expect(
      exchangeSlackConsentCode(config, "c1", { fetch: respond(body) }),
    ).resolves.toMatchObject({
      ok: false,
      reason: "token_rotation_enabled",
      token: FIXTURE.authed_user.access_token,
    });
  });
});

describe("revokeSlackToken", () => {
  const token = "xoxp-9";

  it("revokes with the token as a bearer header", async () => {
    const fetch = respond({ ok: true, revoked: true });
    await expect(revokeSlackToken(token, { fetch })).resolves.toBe("revoked");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(SLACK_REVOKE_URL);
    expect(init?.method).toBe("POST");
    expect(init?.headers).toEqual({ Authorization: `Bearer ${token}` });
  });

  it.each([
    "invalid_auth",
    "token_revoked",
    "token_expired",
    "account_inactive",
    "not_authed",
  ])("treats %s as already invalid", async (error) => {
    await expect(
      revokeSlackToken(token, { fetch: respond({ ok: false, error }) }),
    ).resolves.toBe("already_invalid");
  });

  it("reports any other Slack error", async () => {
    await expect(
      revokeSlackToken(token, {
        fetch: respond({ ok: false, error: "ratelimited" }),
      }),
    ).resolves.toEqual({ failed: "ratelimited" });
  });

  it("reports a network failure or an unreadable body", async () => {
    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    await expect(
      revokeSlackToken(token, { fetch: unreachable }),
    ).resolves.toEqual({ failed: "network" });
    await expect(
      revokeSlackToken(token, { fetch: respond("nope") }),
    ).resolves.toEqual({ failed: "network" });
  });
});
