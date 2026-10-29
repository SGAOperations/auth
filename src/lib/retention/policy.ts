import { SESSION_ABSOLUTE_MAX_AGE_MS } from "@/lib/auth/session-lifetime";

// Pure on purpose: no `server-only`, no database and no env, so every threshold
// and all the date math can be unit tested. The thresholds are repeated in
// docs/DATA_HANDLING.md (Retention); when this file and that one disagree, this
// file wins.

const DAY_MS = 24 * 60 * 60 * 1000;

/** A deactivated user is tombstoned this long after `deactivatedAt`. */
export const DEACTIVATED_TOMBSTONE_AFTER_DAYS = 30;

/** The inactivity notice goes out after 11 months without a sign-in. */
export const INACTIVITY_NOTICE_AFTER_DAYS = 335;

/** An inactive user is tombstoned after 12 months without a sign-in. */
export const INACTIVITY_TOMBSTONE_AFTER_DAYS = 365;

/** A notice always gives at least this long before the tombstone. */
export const INACTIVITY_NOTICE_MIN_LEAD_DAYS = 30;

/** A self sign-up that never signed in or verified is tombstoned after this. */
export const UNVERIFIED_SIGNUP_MAX_AGE_DAYS = 7;

/** IP and user agent are nulled on audit rows older than this. */
export const PII_MAX_AGE_DAYS = 90;

/**
 * Caps per run, so a first run over a large backlog cannot exhaust the
 * function or Resend's free-plan daily limit. Rows over a cap wait for the
 * next day's run.
 */
export const TOMBSTONE_BATCH = 50;
export const NOTICE_BATCH = 50;

export const TOMBSTONE_NAME = "Deleted user";

export function tombstoneEmail(userId: string): string {
  return `deleted+${userId}@invalid`;
}

export interface Cutoffs {
  /** `deactivatedAt` at or before this is due for a tombstone. */
  deactivatedBefore: Date;
  /** An inactivity reference at or before this is due for a notice. */
  noticeBefore: Date;
  /** An inactivity reference at or before this is due for a tombstone. */
  inactiveBefore: Date;
  /** A notice sent at or before this has given its full lead time. */
  noticeSentBefore: Date;
  unverifiedBefore: Date;
  piiBefore: Date;
  /** A session created at or before this is past the absolute cap. */
  sessionCreatedBefore: Date;
}

const daysBefore = (now: Date, days: number) =>
  new Date(now.getTime() - days * DAY_MS);

/**
 * Every database comparison in the job uses these dates, never SQL `now()`, so
 * a test's fake clock drives them.
 */
export function cutoffs(now: Date): Cutoffs {
  return {
    deactivatedBefore: daysBefore(now, DEACTIVATED_TOMBSTONE_AFTER_DAYS),
    noticeBefore: daysBefore(now, INACTIVITY_NOTICE_AFTER_DAYS),
    inactiveBefore: daysBefore(now, INACTIVITY_TOMBSTONE_AFTER_DAYS),
    noticeSentBefore: daysBefore(now, INACTIVITY_NOTICE_MIN_LEAD_DAYS),
    unverifiedBefore: daysBefore(now, UNVERIFIED_SIGNUP_MAX_AGE_DAYS),
    piiBefore: daysBefore(now, PII_MAX_AGE_DAYS),
    sessionCreatedBefore: new Date(now.getTime() - SESSION_ABSOLUTE_MAX_AGE_MS),
  };
}

/**
 * When inactivity is measured from. An invited or imported user who never
 * signed in ages from creation.
 */
export function inactivityReference(user: {
  lastLoginAt: Date | null;
  createdAt: Date;
}): Date {
  return user.lastLoginAt ?? user.createdAt;
}

/**
 * Whether the notice on record still counts. A sign-in after the notice
 * supersedes it, so the user is noticed again after the next 11 months.
 */
export function noticeIsCurrent(
  reference: Date,
  noticeSentAt: Date | null,
): noticeSentAt is Date {
  return noticeSentAt !== null && noticeSentAt.getTime() > reference.getTime();
}

/**
 * The first moment an inactive user may be tombstoned, and the date the notice
 * email states. A notice sent late still gives the full lead time.
 */
export function inactivityDeadline(
  reference: Date,
  noticeSentAt: Date | null,
): Date {
  const byAge = reference.getTime() + INACTIVITY_TOMBSTONE_AFTER_DAYS * DAY_MS;
  if (!noticeIsCurrent(reference, noticeSentAt)) return new Date(byAge);
  const byLead =
    noticeSentAt.getTime() + INACTIVITY_NOTICE_MIN_LEAD_DAYS * DAY_MS;
  return new Date(Math.max(byAge, byLead));
}

/** The date the notice is first due. */
export function inactivityNoticeDue(reference: Date): Date {
  return new Date(reference.getTime() + INACTIVITY_NOTICE_AFTER_DAYS * DAY_MS);
}

/** The date a deactivated user is tombstoned. */
export function deactivatedTombstoneAt(deactivatedAt: Date): Date {
  return new Date(
    deactivatedAt.getTime() + DEACTIVATED_TOMBSTONE_AFTER_DAYS * DAY_MS,
  );
}
