import "server-only";
import type { Prisma } from "@/generated/prisma/client";
import type { SendResult } from "@/lib/email/mailer";
import {
  INVITE_BATCH_MAX,
  type InviteCounts,
  type InviteStatus,
} from "@/lib/user-import/contract";

/** What one invite attempt came to. `rate_limited` is the per-user token limit. */
export type InviteAttempt = SendResult | { status: "rate_limited" };

export interface InviteDeps {
  /**
   * Issues, sends and audits one admin invite (the #34 sender). Never called
   * for a user who has a password or was invited before.
   */
  sendInvite(userId: string): Promise<InviteAttempt>;
  db: Pick<Prisma.TransactionClient, "user" | "account" | "auditEvent">;
  sleep(ms: number): Promise<void>;
  /** Resend allows a few requests a second, so sends are spaced out. */
  spacingMs?: number;
}

export interface InviteOutcome {
  statuses: Map<string, InviteStatus>;
  counts: InviteCounts;
}

const COUNT_KEY: Record<InviteStatus, keyof InviteCounts> = {
  sent: "sent",
  rate_limited: "rateLimited",
  failed: "failed",
  skipped_has_password: "skippedHasPassword",
  skipped_already_invited: "skippedAlreadyInvited",
  deferred_batch: "deferredBatch",
  deferred_daily_cap: "deferredDailyCap",
};

const DAILY_CAP = "global:1d";

/**
 * Sends set-password invites after the import has committed, so a failure here
 * never undoes it. Eligible users are active, have no password and were never
 * invited; everyone else is reported, not mailed. Sends are sequential and
 * spaced, stop after `INVITE_BATCH_MAX`, and stop for the day at the global
 * email cap. Never throws for a send outcome.
 */
export async function sendImportInvites(
  userIds: readonly string[],
  { sendInvite, db, sleep, spacingMs = 500 }: InviteDeps,
): Promise<InviteOutcome> {
  const ids = [...new Set(userIds)];
  const [active, withPassword, invited] =
    ids.length === 0
      ? [[], [], []]
      : await Promise.all([
          db.user.findMany({
            where: { id: { in: ids }, status: "ACTIVE" },
            select: { id: true },
          }),
          db.account.findMany({
            where: {
              userId: { in: ids },
              providerId: "credential",
              password: { not: null },
            },
            select: { userId: true },
          }),
          db.auditEvent.findMany({
            where: {
              type: "USER_INVITED",
              targetType: "USER",
              targetId: { in: ids },
            },
            select: { targetId: true },
          }),
        ]);
  const isActive = new Set(active.map((user) => user.id));
  const hasPassword = new Set(withPassword.map((account) => account.userId));
  const wasInvited = new Set(invited.map((event) => event.targetId));

  const statuses = new Map<string, InviteStatus>();
  const queue: string[] = [];
  for (const id of ids) {
    if (!isActive.has(id)) statuses.set(id, "failed");
    else if (hasPassword.has(id)) statuses.set(id, "skipped_has_password");
    else if (wasInvited.has(id)) statuses.set(id, "skipped_already_invited");
    else queue.push(id);
  }

  let attempted = 0;
  let capped = false;
  for (const id of queue) {
    if (capped) {
      statuses.set(id, "deferred_daily_cap");
      continue;
    }
    if (attempted >= INVITE_BATCH_MAX) {
      statuses.set(id, "deferred_batch");
      continue;
    }
    if (attempted > 0) await sleep(spacingMs);
    attempted += 1;

    let attempt: InviteAttempt;
    try {
      attempt = await sendInvite(id);
    } catch {
      attempt = { status: "failed" };
    }
    if (attempt.status === "capped") {
      if (attempt.cap === DAILY_CAP) {
        capped = true;
        statuses.set(id, "deferred_daily_cap");
      } else {
        statuses.set(id, "rate_limited");
      }
    } else {
      statuses.set(id, attempt.status);
    }
  }

  const counts: InviteCounts = {
    sent: 0,
    deferredBatch: 0,
    deferredDailyCap: 0,
    rateLimited: 0,
    failed: 0,
    skippedHasPassword: 0,
    skippedAlreadyInvited: 0,
  };
  for (const status of statuses.values()) counts[COUNT_KEY[status]] += 1;
  return { statuses, counts };
}
