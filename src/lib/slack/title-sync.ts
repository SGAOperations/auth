import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import type { Logger } from "@/lib/log/logger";
import {
  SLACK_CALL_INTERVAL_MS,
  SLACK_WRITE_INTERVAL_MS,
  findLeadershipFieldId,
  getOwnSlackProfile,
  normalizeSlackText,
  setOwnSlackProfile,
  type SlackCallFailure,
} from "@/lib/slack/profile-api";
import { leadershipTitle } from "@/lib/slack/title";
import { decryptSlackToken, takeSlackUserToken } from "@/lib/slack/user-token";

// The leadership title sync (#359). For each leader who allowed title updates
// (#358), it writes the title built from their positions to their own Slack
// profile, reads it back, and counts them as synced only when the read-back
// matches: Slack can accept a write and ignore it.
//
// Each run takes the least recently checked people first and stops at a time
// budget or an HTTP 429, so later runs finish the rest. Calls are paced under
// Slack's per-token limits (profile-api.ts).
//
// Writes the audit events SLACK_TITLE_SET and SLACK_TITLE_MISMATCH, and
// SLACK_TOKEN_REVOKED (through takeSlackUserToken) when Slack says a token is
// dead. A person with no leadership position is skipped: clearing a title on
// loss of leadership is #360.

const SYSTEM = { actorType: "SYSTEM" } as const;

/** The time a run may spend before it starts no further person. */
export const SLACK_TITLE_SYNC_BUDGET_MS = 35_000;

export type SlackTitleSyncReport = {
  dryRun: boolean;
  candidates: number;
  synced: number;
  unchanged: number;
  mismatched: number;
  /** Tokens Slack reported dead; the row is deleted, the Slack link stays. */
  unlinked: number;
  /** A leadership title over the length limit. */
  refused: number;
  errors: number;
  /** A dry run's count of people a real run would write. */
  wouldWrite: number;
  /** Candidates not reached because the run stopped early. */
  remaining: number;
  stoppedReason: "time_budget" | "rate_limited" | null;
};

export interface SlackTitleSyncDeps {
  db: PrismaClient;
  teamId: string;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  fetch?: typeof fetch;
  decrypt?: (ciphertext: string) => Promise<string>;
  budgetMs?: number;
  dryRun: boolean;
  log: Pick<Logger, "info" | "warn" | "error">;
}

/** Thrown before any write when the workspace has no "Active Leadership" field. */
export class SlackLeadershipFieldMissingError extends Error {
  constructor() {
    super("slack_leadership_field_missing");
    this.name = "SlackLeadershipFieldMissingError";
  }
}

const defaultSleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runSlackTitleSync(
  deps: SlackTitleSyncDeps,
): Promise<SlackTitleSyncReport> {
  const {
    db,
    teamId,
    dryRun,
    log,
    now = Date.now,
    sleep = defaultSleep,
    decrypt = decryptSlackToken,
    budgetMs = SLACK_TITLE_SYNC_BUDGET_MS,
  } = deps;
  const api = { fetch: deps.fetch };

  const candidates = await db.slackUserToken.findMany({
    where: {
      slackTeamId: teamId,
      user: {
        status: "ACTIVE",
        positions: {
          some: { position: { deletedAt: null, isLeadership: true } },
        },
      },
    },
    orderBy: [
      { titleCheckedAt: { sort: "asc", nulls: "first" } },
      { id: "asc" },
    ],
    select: {
      userId: true,
      token: true,
      user: {
        select: {
          positions: {
            where: { position: { deletedAt: null } },
            select: {
              position: {
                select: { key: true, name: true, isLeadership: true },
              },
            },
          },
        },
      },
    },
  });

  const report: SlackTitleSyncReport = {
    dryRun,
    candidates: candidates.length,
    synced: 0,
    unchanged: 0,
    mismatched: 0,
    unlinked: 0,
    refused: 0,
    errors: 0,
    wouldWrite: 0,
    remaining: 0,
    stoppedReason: null,
  };

  // The pacer: a minimum gap before any call, and a longer one before a write.
  let lastCallAt: number | null = null;
  let lastWriteAt: number | null = null;
  const pace = async (write: boolean) => {
    let wait = 0;
    if (lastCallAt !== null) {
      wait = Math.max(wait, lastCallAt + SLACK_CALL_INTERVAL_MS - now());
    }
    if (write && lastWriteAt !== null) {
      wait = Math.max(wait, lastWriteAt + SLACK_WRITE_INTERVAL_MS - now());
    }
    if (wait > 0) await sleep(wait);
    lastCallAt = now();
    if (write) lastWriteAt = lastCallAt;
  };

  const started = now();
  let fieldId: string | undefined;
  let processed = 0;

  for (const candidate of candidates) {
    if (now() - started >= budgetMs) {
      report.stoppedReason = "time_budget";
      break;
    }
    const { userId, token: ciphertext } = candidate;

    // Matches the ciphertext too, so a grant replaced mid-run is not stamped
    // with the old grant's result. A dry run stamps nothing.
    const stamp = async (
      synced: boolean,
      tx: Pick<PrismaClient, "slackUserToken"> = db,
    ) => {
      if (dryRun) return;
      const at = new Date(now());
      await tx.slackUserToken.updateMany({
        where: { userId, token: ciphertext },
        data: synced
          ? { titleCheckedAt: at, titleSyncedAt: at }
          : { titleCheckedAt: at },
      });
    };

    /**
     * Handles a failed call. Returns true when the run must stop. A revoked
     * token deletes the row and audits the event type "SLACK_TOKEN_REVOKED".
     */
    const onFailure = async (
      failure: SlackCallFailure,
      step: string,
    ): Promise<boolean> => {
      if (failure.kind === "rate_limited") {
        report.stoppedReason = "rate_limited";
        log.warn("slack_title_sync_rate_limited", {
          retryAfterSeconds: failure.retryAfterSeconds,
        });
        return true;
      }
      if (failure.kind === "revoked") {
        // The token is already dead at Slack, so there is nothing to revoke.
        // The user withdrew title consent, not their Slack link.
        // Deletes only the grant this run read: one replaced since is live.
        const taken = dryRun
          ? null
          : await db.$transaction((tx) =>
              takeSlackUserToken(tx, userId, "revoked_at_slack", {
                actor: SYSTEM,
                detached: true,
                expectedCiphertext: ciphertext,
              }),
            );
        if (dryRun || taken !== null) report.unlinked += 1;
        return false;
      }
      report.errors += 1;
      log.error("slack_title_sync_error", {
        userId,
        step,
        slackError: failure.error,
      });
      await stamp(false);
      return false;
    };

    const desired = leadershipTitle(
      candidate.user.positions.map(({ position }) => position),
    );
    if (!desired.ok) {
      report.refused += 1;
      log.warn("slack_title_refused", { userId, length: desired.length });
      await stamp(false);
      processed += 1;
      continue;
    }
    const title = desired.title;

    let token: string;
    try {
      token = await decrypt(ciphertext);
    } catch {
      report.errors += 1;
      log.error("slack_title_sync_error", { userId, reason: "undecryptable" });
      await stamp(false);
      processed += 1;
      continue;
    }

    if (fieldId === undefined) {
      await pace(false);
      const found = await findLeadershipFieldId(token, api);
      if (!found.ok) {
        if (await onFailure(found.failure, "field_lookup")) break;
        processed += 1;
        continue;
      }
      if (found.fieldId === null) throw new SlackLeadershipFieldMissingError();
      fieldId = found.fieldId;
    }

    await pace(false);
    const before = await getOwnSlackProfile(token, api);
    if (!before.ok) {
      if (await onFailure(before.failure, "profile_get")) break;
      processed += 1;
      continue;
    }
    if (
      normalizeSlackText(before.title) === title &&
      normalizeSlackText(before.fields[fieldId] ?? "") === title
    ) {
      report.unchanged += 1;
      await stamp(true);
      processed += 1;
      continue;
    }

    if (dryRun) {
      report.wouldWrite += 1;
      processed += 1;
      continue;
    }

    await pace(true);
    const written = await setOwnSlackProfile(
      token,
      { title, fieldId, value: title },
      api,
    );
    if (!written.ok) {
      if (await onFailure(written.failure, "profile_set")) break;
      processed += 1;
      continue;
    }

    await pace(false);
    const after = await getOwnSlackProfile(token, api);
    if (!after.ok) {
      if (await onFailure(after.failure, "read_back")) break;
      processed += 1;
      continue;
    }
    const titleMatched = normalizeSlackText(after.title) === title;
    const fieldMatched =
      normalizeSlackText(after.fields[fieldId] ?? "") === title;
    const event = {
      ...SYSTEM,
      targetType: "USER" as const,
      targetId: userId,
      ip: null,
      userAgent: null,
    };
    if (titleMatched && fieldMatched) {
      report.synced += 1;
      await db.$transaction(async (tx) => {
        await writeAuditEvent(tx, {
          ...event,
          type: "SLACK_TITLE_SET",
          metadata: { slackTeamId: teamId, title },
        });
        await stamp(true, tx);
      });
    } else {
      report.mismatched += 1;
      log.warn("slack_title_mismatch", { userId, titleMatched, fieldMatched });
      await db.$transaction(async (tx) => {
        await writeAuditEvent(tx, {
          ...event,
          type: "SLACK_TITLE_MISMATCH",
          metadata: { slackTeamId: teamId, title, titleMatched, fieldMatched },
        });
        await stamp(false, tx);
      });
    }
    processed += 1;
  }

  report.remaining = candidates.length - processed;
  return report;
}
