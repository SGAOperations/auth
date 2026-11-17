import { symmetricEncrypt } from "better-auth/crypto";
import { describe, expect, it, vi } from "vitest";
import {
  decryptSlackToken,
  revokeSlackToken,
  slackTokenKey,
} from "@/lib/slack/user-token-retirement";

const TOKEN = "xoxp-1111-2222-3333-aaaa";
const legacySecret = "L".repeat(32);
const secretOne = "1".repeat(32);
const secretTwo = "2".repeat(32);

const encrypt = (token: string, key: ReturnType<typeof slackTokenKey>) =>
  symmetricEncrypt({ key, data: token });

describe("Slack user token key", () => {
  it("round-trips, and the ciphertext holds no part of the token", async () => {
    const key = slackTokenKey({ legacySecret, secrets: undefined });
    const ciphertext = await encrypt(TOKEN, key);
    expect(ciphertext).not.toContain("xoxp-");
    expect(ciphertext).not.toContain(TOKEN.slice(5));
    await expect(decryptSlackToken(ciphertext, key)).resolves.toBe(TOKEN);
  });

  it("still decrypts a value written under version 1 after version 2 is added", async () => {
    const v1 = slackTokenKey({
      legacySecret,
      secrets: [{ version: 1, value: secretOne }],
    });
    const ciphertext = await encrypt(TOKEN, v1);
    expect(ciphertext.startsWith("$ba$1$")).toBe(true);

    const v2 = slackTokenKey({
      legacySecret,
      secrets: [
        { version: 2, value: secretTwo },
        { version: 1, value: secretOne },
      ],
    });
    await expect(decryptSlackToken(ciphertext, v2)).resolves.toBe(TOKEN);
  });

  it("decrypts a value written before any versioned secret through the legacy secret", async () => {
    const plain = slackTokenKey({ legacySecret, secrets: undefined });
    const ciphertext = await encrypt(TOKEN, plain);
    expect(ciphertext.startsWith("$ba$")).toBe(false);

    const versioned = slackTokenKey({
      legacySecret,
      secrets: [{ version: 1, value: secretOne }],
    });
    await expect(decryptSlackToken(ciphertext, versioned)).resolves.toBe(TOKEN);
  });

  it("does not decrypt under another secret", async () => {
    const ciphertext = await encrypt(
      TOKEN,
      slackTokenKey({ legacySecret, secrets: undefined }),
    );
    await expect(
      decryptSlackToken(
        ciphertext,
        slackTokenKey({ legacySecret: secretOne, secrets: undefined }),
      ),
    ).rejects.toThrow();
  });

  it("derives a key that differs from the raw secret", async () => {
    // A token encrypted with the derived key cannot be read with the raw auth
    // secret, which also keys other Better Auth data.
    const ciphertext = await encrypt(
      TOKEN,
      slackTokenKey({ legacySecret, secrets: undefined }),
    );
    await expect(decryptSlackToken(ciphertext, legacySecret)).rejects.toThrow();
  });
});

const respond = (body: unknown) =>
  vi.fn<typeof fetch>(async () => Response.json(body));

// Slack's contract, read on 2026-11-07 from
// https://docs.slack.dev/reference/methods/auth.revoke (`token` as a bearer
// header; `{ok, revoked}`; `invalid_auth`, `token_revoked`, `token_expired`,
// `account_inactive`, `not_authed`).
describe("revokeSlackToken", () => {
  const token = "xoxp-9";

  it("revokes with the token as a bearer header", async () => {
    const fetch = respond({ ok: true, revoked: true });
    await expect(revokeSlackToken(token, { fetch })).resolves.toBe("revoked");
    const [url, init] = fetch.mock.calls[0];
    expect(url).toBe("https://slack.com/api/auth.revoke");
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
