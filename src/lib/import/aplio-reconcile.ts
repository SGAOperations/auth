import type { AplioExisting, AplioRow } from "./aplio";

// The read-only diff run before Aplio's reads switch to SGAuth. Pure: it
// compares an Aplio export with what SGAuth holds and decides READY. It never
// writes, and imports no mailer or auth code. See docs/runbooks/aplio-import.md.

export const RECONCILE_CATEGORIES = [
  "ok",
  "missing-in-sgauth",
  "needs-backfill",
  "mismatch",
  "blocked",
] as const;

export type ReconcileCategory = (typeof RECONCILE_CATEGORIES)[number];

/** The categories that must be empty before the switch. */
export const BLOCKING_CATEGORIES = [
  "missing-in-sgauth",
  "needs-backfill",
  "mismatch",
  "blocked",
] as const satisfies readonly ReconcileCategory[];

export type ReconcileState = {
  /** Existing users by lower-cased email. */
  users: Map<string, AplioExisting>;
};

/** A user created through the dual-write endpoint. */
export type DualWriteUser = { userId: string; email: string };

export type ReconcileEntry = {
  aplioId: string;
  email: string;
  category: ReconcileCategory;
};

export type ReconcileResult = {
  entries: ReconcileEntry[];
  counts: Record<ReconcileCategory, number>;
  /** Dual-written users that match no live export row: a review list. */
  sgauthOnly: DualWriteUser[];
  ready: boolean;
  /** Why it is not ready; empty when it is. */
  reasons: string[];
};

function categorize(
  row: AplioRow,
  user: AplioExisting | undefined,
): ReconcileCategory {
  if (user === undefined) return "missing-in-sgauth";
  if (user.status === "DELETED" || !user.emailVerified) return "blocked";
  if (row.sgauthUserId === null) return "needs-backfill";
  return row.sgauthUserId === user.id ? "ok" : "mismatch";
}

export function reconcileAplio(
  rows: AplioRow[],
  state: ReconcileState,
  dualWriteUsers: DualWriteUser[],
  now: Date,
  cutoverAt: Date,
): ReconcileResult {
  const counts = Object.fromEntries(
    RECONCILE_CATEGORIES.map((category) => [category, 0]),
  ) as Record<ReconcileCategory, number>;
  const liveEmails = new Set<string>();
  const entries: ReconcileEntry[] = [];

  for (const row of rows) {
    if (row.deletedAt !== null) continue;
    liveEmails.add(row.email);
    const category = categorize(row, state.users.get(row.email));
    counts[category] += 1;
    entries.push({ aplioId: row.aplioId, email: row.email, category });
  }

  const sgauthOnly = dualWriteUsers.filter(
    (user) => !liveEmails.has(user.email.toLowerCase()),
  );

  const reasons: string[] = [];
  for (const category of BLOCKING_CATEGORIES) {
    if (counts[category] > 0) {
      reasons.push(`${counts[category]} ${category}`);
    }
  }
  // Exactly at the cutover is already past it: the endpoint answers 410.
  if (now.getTime() >= cutoverAt.getTime()) reasons.push("cutover has passed");

  return {
    entries,
    counts,
    sgauthOnly,
    ready: reasons.length === 0,
    reasons,
  };
}
