import { describe, expect, it, vi } from "vitest";
import { SignJWT, createLocalJWKSet, exportJWK, generateKeyPair } from "jose";
import {
  SLACK_ISSUER,
  SLACK_TOKEN_URL,
  completeSlackOpenId,
  slackAuthorizeUrl,
} from "@/lib/slack/openid";

const config = {
  clientId: "123.456",
  clientSecret: "shh",
  teamId: "T0SGA",
  redirectUri: "https://auth.example/account/slack/callback",
};

async function keys() {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const jwk = { ...(await exportJWK(publicKey)), kid: "k1", alg: "RS256" };
  return { privateKey, jwks: createLocalJWKSet({ keys: [jwk] }) };
}

async function idToken(
  privateKey: CryptoKey,
  claims: Record<string, unknown> = {},
  options: { issuer?: string; audience?: string; expiresIn?: string } = {},
) {
  return new SignJWT({
    nonce: "n1",
    "https://slack.com/user_id": "U0ME",
    "https://slack.com/team_id": "T0SGA",
    ...claims,
  })
    .setProtectedHeader({ alg: "RS256", kid: "k1" })
    .setIssuer(options.issuer ?? SLACK_ISSUER)
    .setAudience(options.audience ?? config.clientId)
    .setIssuedAt()
    .setExpirationTime(options.expiresIn ?? "5m")
    .sign(privateKey);
}

const tokenResponse = (body: unknown, status = 200) =>
  vi.fn<typeof fetch>(async () => Response.json(body, { status }));

describe("slackAuthorizeUrl", () => {
  it("asks Slack for an OpenID code for the SGA workspace", () => {
    const url = new URL(slackAuthorizeUrl(config, "s1", "n1"));
    expect(url.origin + url.pathname).toBe(
      "https://slack.com/openid/connect/authorize",
    );
    expect(Object.fromEntries(url.searchParams)).toEqual({
      response_type: "code",
      scope: "openid",
      client_id: config.clientId,
      redirect_uri: config.redirectUri,
      state: "s1",
      nonce: "n1",
      team: "T0SGA",
    });
  });
});

describe("completeSlackOpenId", () => {
  it("returns the Slack account of a valid ID token", async () => {
    const { privateKey, jwks } = await keys();
    const fetch = tokenResponse({
      ok: true,
      id_token: await idToken(privateKey),
    });
    await expect(
      completeSlackOpenId(config, { code: "c1", nonce: "n1" }, { fetch, jwks }),
    ).resolves.toEqual({ ok: true, slackTeamId: "T0SGA", slackUserId: "U0ME" });
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe(SLACK_TOKEN_URL);
    expect(Object.fromEntries(init?.body as URLSearchParams)).toEqual({
      client_id: config.clientId,
      client_secret: config.clientSecret,
      code: "c1",
      redirect_uri: config.redirectUri,
    });
  });

  it.each([
    ["Slack refuses the code", { ok: false, error: "invalid_code" }, 200],
    ["no id_token", { ok: true }, 200],
    ["an HTTP error", { ok: true, id_token: "x" }, 500],
  ])("fails the exchange on %s", async (_name, body, status) => {
    const { jwks } = await keys();
    await expect(
      completeSlackOpenId(
        config,
        { code: "c1", nonce: "n1" },
        { fetch: tokenResponse(body, status), jwks },
      ),
    ).resolves.toEqual({ ok: false, reason: "token_exchange_failed" });
  });

  it("fails the exchange when Slack is unreachable", async () => {
    const { jwks } = await keys();
    const unreachable = vi.fn<typeof fetch>(async () => {
      throw new TypeError("network");
    });
    await expect(
      completeSlackOpenId(
        config,
        { code: "c1", nonce: "n1" },
        { fetch: unreachable, jwks },
      ),
    ).resolves.toEqual({ ok: false, reason: "token_exchange_failed" });
  });

  it.each([
    ["another issuer", {}, { issuer: "https://evil.example" }],
    ["another audience", {}, { audience: "someone-else" }],
    ["an expired token", {}, { expiresIn: "-1m" }],
    ["another nonce", { nonce: "n2" }, {}],
    ["no Slack user id", { "https://slack.com/user_id": undefined }, {}],
  ])("refuses %s", async (_name, claims, options) => {
    const { privateKey, jwks } = await keys();
    const fetch = tokenResponse({
      ok: true,
      id_token: await idToken(privateKey, claims, options),
    });
    await expect(
      completeSlackOpenId(config, { code: "c1", nonce: "n1" }, { fetch, jwks }),
    ).resolves.toEqual({ ok: false, reason: "invalid_id_token" });
  });

  it("refuses a token signed by another key", async () => {
    const { jwks } = await keys();
    const other = await keys();
    const fetch = tokenResponse({
      ok: true,
      id_token: await idToken(other.privateKey),
    });
    await expect(
      completeSlackOpenId(config, { code: "c1", nonce: "n1" }, { fetch, jwks }),
    ).resolves.toEqual({ ok: false, reason: "invalid_id_token" });
  });

  it("refuses another workspace", async () => {
    const { privateKey, jwks } = await keys();
    const fetch = tokenResponse({
      ok: true,
      id_token: await idToken(privateKey, {
        "https://slack.com/team_id": "T0OTHER",
      }),
    });
    await expect(
      completeSlackOpenId(config, { code: "c1", nonce: "n1" }, { fetch, jwks }),
    ).resolves.toEqual({ ok: false, reason: "wrong_team" });
  });
});
