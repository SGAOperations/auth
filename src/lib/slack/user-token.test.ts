import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/auth/settings", () => ({ toAuthSettings: () => ({}) }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import {
  decryptSlackToken,
  encryptSlackToken,
  slackTokenKey,
} from "@/lib/slack/user-token";

const TOKEN = "xoxp-1111-2222-3333-aaaa";
const legacySecret = "L".repeat(32);
const secretOne = "1".repeat(32);
const secretTwo = "2".repeat(32);

describe("Slack user token encryption", () => {
  it("round-trips, and the ciphertext holds no part of the token", async () => {
    const key = slackTokenKey({ legacySecret, secrets: undefined });
    const ciphertext = await encryptSlackToken(TOKEN, key);
    expect(ciphertext).not.toContain("xoxp-");
    expect(ciphertext).not.toContain(TOKEN.slice(5));
    await expect(decryptSlackToken(ciphertext, key)).resolves.toBe(TOKEN);
  });

  it("encrypts differently each time", async () => {
    const key = slackTokenKey({ legacySecret, secrets: undefined });
    expect(await encryptSlackToken(TOKEN, key)).not.toBe(
      await encryptSlackToken(TOKEN, key),
    );
  });

  it("still decrypts a value written under version 1 after version 2 is added", async () => {
    const v1 = slackTokenKey({
      legacySecret,
      secrets: [{ version: 1, value: secretOne }],
    });
    const ciphertext = await encryptSlackToken(TOKEN, v1);
    expect(ciphertext.startsWith("$ba$1$")).toBe(true);

    const v2 = slackTokenKey({
      legacySecret,
      secrets: [
        { version: 2, value: secretTwo },
        { version: 1, value: secretOne },
      ],
    });
    await expect(decryptSlackToken(ciphertext, v2)).resolves.toBe(TOKEN);
    expect((await encryptSlackToken(TOKEN, v2)).startsWith("$ba$2$")).toBe(
      true,
    );
  });

  it("decrypts a value written before any versioned secret through the legacy secret", async () => {
    const plain = slackTokenKey({ legacySecret, secrets: undefined });
    const ciphertext = await encryptSlackToken(TOKEN, plain);
    expect(ciphertext.startsWith("$ba$")).toBe(false);

    const versioned = slackTokenKey({
      legacySecret,
      secrets: [{ version: 1, value: secretOne }],
    });
    await expect(decryptSlackToken(ciphertext, versioned)).resolves.toBe(TOKEN);
  });

  it("does not decrypt under another secret", async () => {
    const ciphertext = await encryptSlackToken(
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
    const ciphertext = await encryptSlackToken(
      TOKEN,
      slackTokenKey({ legacySecret, secrets: undefined }),
    );
    await expect(decryptSlackToken(ciphertext, legacySecret)).rejects.toThrow();
  });
});
