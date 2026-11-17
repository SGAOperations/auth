import "server-only";
import { hkdfSync } from "node:crypto";
import { symmetricDecrypt, type SecretConfig } from "better-auth/crypto";
import type { PrismaClient } from "@/generated/prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import type { VersionedSecret } from "@/lib/env-schema";

// Retires the Slack user tokens leaders granted for title updates. Each stored
// xoxp- token is revoked at Slack with auth.revoke first, then deleted with its
// audit row in one transaction, because deleting the ciphertext alone would
// leave the token valid at Slack with no way left to revoke it.
//
// Run once per environment by scripts/retire-slack-user-tokens.ts (see
// docs/runbooks/slack-token-retirement.md); the follow-up contract release
// drops the table and this module with it. It imports neither the app env nor
// the shared Prisma client, so the script supplies both. Nothing here ever logs
// or returns a token.

const KEY_PURPOSE = "sgauth:slack-user-token";
const REVOKE_URL = "https://slack.com/api/auth.revoke";
const TIMEOUT_MS = 10_000;

interface KeySettings {
  legacySecret: string;
  secrets: readonly VersionedSecret[] | undefined;
}

const derive = (secret: string): string =>
  Buffer.from(hkdfSync("sha256", secret, KEY_PURPOSE, "v1", 32)).toString(
    "hex",
  );

/**
 * Better Auth's secret config for the stored tokens: a key derived from the auth
 * secrets for this purpose only. With no versioned secrets the key is one derived
 * string, which Better Auth reads as the legacy secret once versioned secrets are
 * added, so a rotation never strands a stored token.
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

export const decryptSlackToken = (
  ciphertext: string,
  key: string | SecretConfig,
): Promise<string> => symmetricDecrypt({ key, data: ciphertext });

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
    const response = await doFetch(REVOKE_URL, {
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

export interface RetirementResult {
  /** Rows in the table when the run started. */
  found: number;
  revoked: number;
  alreadyInvalid: number;
  /** SGAuth user ids whose token could not be revoked, for the operator to chase in Slack. */
  failedUserIds: string[];
}

/**
 * Deletes every stored token and revokes it at Slack. A dry run only counts.
 * With `apply`, each token is revoked at Slack first, then its row is deleted in
 * its own transaction together with its SLACK_TOKEN_REVOKED row (actor SYSTEM,
 * no network details). A token that Slack will not revoke, or that cannot be
 * decrypted, is deleted anyway, written as SLACK_TOKEN_REVOKE_FAILED instead and
 * returned in `failedUserIds`. A run that stops after the revoke leaves the row
 * and no audit row. Idempotent: a second run finds nothing.
 */
export async function retireSlackUserTokens(
  db: PrismaClient,
  options: {
    apply: boolean;
    key: string | SecretConfig;
    revoke?: typeof revokeSlackToken;
  },
): Promise<RetirementResult> {
  const revoke = options.revoke ?? revokeSlackToken;
  const rows = await db.slackUserToken.findMany({
    select: { id: true, userId: true, token: true, slackTeamId: true },
    orderBy: { id: "asc" },
  });
  const result: RetirementResult = {
    found: rows.length,
    revoked: 0,
    alreadyInvalid: 0,
    failedUserIds: [],
  };
  if (!options.apply) return result;

  for (const row of rows) {
    // Slack first, then delete and audit in one transaction. A run that stops in
    // between leaves the row in place, so the next run revokes it again (Slack
    // answers already invalid) and the audit log never claims a revoke that did
    // not happen.
    let outcome: SlackRevokeResult;
    try {
      outcome = await revoke(await decryptSlackToken(row.token, options.key));
    } catch {
      // The ciphertext could not be read, so there is nothing to send to Slack.
      outcome = { failed: "undecryptable" };
    }

    const deleted = await db.$transaction(async (tx) => {
      const { count } = await tx.slackUserToken.deleteMany({
        where: { id: row.id, token: row.token },
      });
      if (count !== 1) return false;
      await writeAuditEvent(
        tx,
        typeof outcome === "object"
          ? {
              type: "SLACK_TOKEN_REVOKE_FAILED",
              actorType: "SYSTEM",
              targetType: "USER",
              targetId: row.userId,
              metadata: {
                reason: "retired",
                slackError: outcome.failed.slice(0, 64),
              },
              ip: null,
              userAgent: null,
            }
          : {
              type: "SLACK_TOKEN_REVOKED",
              actorType: "SYSTEM",
              targetType: "USER",
              targetId: row.userId,
              metadata: { reason: "retired", slackTeamId: row.slackTeamId },
              ip: null,
              userAgent: null,
            },
      );
      return true;
    });
    if (!deleted) continue;

    if (outcome === "revoked") result.revoked += 1;
    else if (outcome === "already_invalid") result.alreadyInvalid += 1;
    else result.failedUserIds.push(row.userId);
  }
  return result;
}
