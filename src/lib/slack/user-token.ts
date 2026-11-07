import "server-only";
import { hkdfSync } from "node:crypto";
import {
  symmetricDecrypt,
  symmetricEncrypt,
  type SecretConfig,
} from "better-auth/crypto";
import type { Prisma } from "@/generated/prisma/client";
import {
  audit,
  writeAuditEvent,
  type AuditActor,
  type SlackTokenReason,
} from "@/lib/audit";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { revokeSlackToken } from "@/lib/slack/oauth-v2";

// The xoxp- token a leader granted (#358), encrypted at rest. It is encrypted
// with Better Auth's envelope under a key derived from the auth secrets for this
// purpose only, so BETTER_AUTH_SECRETS versioning applies and the raw auth
// secret never keys the ciphertext directly. The row is deleted in the same
// transaction as its audit row, and Slack's auth.revoke runs after the commit.

type KeySettings = Pick<
  ReturnType<typeof toAuthSettings>,
  "secrets" | "legacySecret"
>;

const KEY_PURPOSE = "sgauth:slack-user-token";

const derive = (secret: string): string =>
  Buffer.from(hkdfSync("sha256", secret, KEY_PURPOSE, "v1", 32)).toString(
    "hex",
  );

/**
 * Better Auth's secret config for this purpose. With no versioned secrets the
 * key is one derived string, which Better Auth reads as the legacy secret once
 * versioned secrets are added, so a rotation never strands a stored token.
 */
export function slackTokenKey(settings: KeySettings): string | SecretConfig {
  const { secrets, legacySecret } = settings;
  if (!secrets) return derive(legacySecret);
  return {
    keys: new Map(
      secrets.map(({ version, value }) => [version, derive(value)]),
    ),
    currentVersion: secrets[0].version,
    legacySecret: derive(legacySecret),
  };
}

let defaultKey: string | SecretConfig | undefined;
const currentKey = () => (defaultKey ??= slackTokenKey(toAuthSettings(env)));

export const encryptSlackToken = (
  token: string,
  key: string | SecretConfig = currentKey(),
): Promise<string> => symmetricEncrypt({ key, data: token });

export const decryptSlackToken = (
  ciphertext: string,
  key: string | SecretConfig = currentKey(),
): Promise<string> => symmetricDecrypt({ key, data: ciphertext });

type Tx = Prisma.TransactionClient;

/**
 * Stores the user's token, replacing any earlier one, and returns the previous
 * ciphertext (null when there was none) so the caller can revoke it.
 */
export async function storeSlackUserToken(
  tx: Tx,
  input: {
    userId: string;
    slackTeamId: string;
    slackUserId: string;
    scopes: string[];
    token: string;
  },
): Promise<{ previousCiphertext: string | null }> {
  const previous = await tx.slackUserToken.findUnique({
    where: { userId: input.userId },
    select: { token: true },
  });
  const data = {
    slackTeamId: input.slackTeamId,
    slackUserId: input.slackUserId,
    scopes: input.scopes.join(","),
    token: await encryptSlackToken(input.token),
    grantedAt: new Date(),
  };
  await tx.slackUserToken.upsert({
    where: { userId: input.userId },
    create: { userId: input.userId, ...data },
    update: data,
  });
  return { previousCiphertext: previous?.token ?? null };
}

/** A token deleted in a transaction and still to be revoked at Slack. */
export interface TakenSlackToken {
  userId: string;
  ciphertext: string;
  reason: SlackTokenReason;
  actor: AuditActor;
  /** The tombstone's rows carry no network details, as its other audit rows. */
  detached: boolean;
}

/**
 * Deletes the user's token and writes SLACK_TOKEN_REVOKED in the same
 * transaction. Returns null, and writes nothing, when there is no token. Call
 * `revokeTakenToken` with the result after the transaction commits.
 */
export async function takeSlackUserToken(
  tx: Tx,
  userId: string,
  reason: SlackTokenReason,
  options: { actor: AuditActor; detached?: boolean },
): Promise<TakenSlackToken | null> {
  const row = await tx.slackUserToken.findUnique({
    where: { userId },
    select: { token: true, slackTeamId: true },
  });
  if (!row) return null;
  const { count } = await tx.slackUserToken.deleteMany({ where: { userId } });
  if (count !== 1) return null;

  const detached = options.detached ?? false;
  const event = {
    type: "SLACK_TOKEN_REVOKED" as const,
    ...options.actor,
    targetType: "USER" as const,
    targetId: userId,
    metadata: { reason, slackTeamId: row.slackTeamId },
  };
  if (detached) {
    await writeAuditEvent(tx, { ...event, ip: null, userAgent: null });
  } else {
    await audit(event);
  }
  return {
    userId,
    ciphertext: row.token,
    reason,
    actor: options.actor,
    detached,
  };
}

/**
 * Revokes a deleted token at Slack. Never throws: a failure is audited as
 * SLACK_TOKEN_REVOKE_FAILED and logged by reason and Slack's error code only,
 * because the user's action has already committed.
 */
export async function revokeTakenToken(
  taken: TakenSlackToken,
  deps: { revoke?: typeof revokeSlackToken } = {},
): Promise<void> {
  const revoke = deps.revoke ?? revokeSlackToken;
  let slackError: string | null = null;
  try {
    const result = await revoke(await decryptSlackToken(taken.ciphertext));
    if (typeof result === "object") slackError = result.failed;
  } catch {
    // The ciphertext could not be read, so there is nothing to send to Slack.
    slackError = "undecryptable";
  }
  if (slackError === null) return;

  logger.warn("slack_token_revoke_failed", {
    reason: taken.reason,
    slackError,
  });
  try {
    const event = {
      type: "SLACK_TOKEN_REVOKE_FAILED" as const,
      ...taken.actor,
      targetType: "USER" as const,
      targetId: taken.userId,
      metadata: { reason: taken.reason, slackError: slackError.slice(0, 64) },
    };
    if (taken.detached) {
      await writeAuditEvent(prisma, { ...event, ip: null, userAgent: null });
    } else {
      await audit(event, { db: prisma });
    }
  } catch {
    logger.warn("slack_token_revoke_failed_unaudited", {
      reason: taken.reason,
    });
  }
}
