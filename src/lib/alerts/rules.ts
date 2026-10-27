import type { AuditEventType } from "@/lib/audit-catalog";
import type { OpsSignalKind } from "@/lib/alerts/signals";

// Pure: type-only imports, so the email template can import the rule keys and
// stay loadable under plain Node.

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/**
 * Shorter than the hour the alerts promise, so a run that Actions starts a few
 * minutes late still fires "an hour later".
 */
export const COOLDOWN_MS = 55 * MINUTE_MS;

/** An `any` rule never looks back further than this, however stale its state. */
export const ANY_LOOKBACK_CAP_MS = 24 * HOUR_MS;

type Source =
  | { source: "audit"; types: readonly AuditEventType[] }
  | { source: "signal"; kinds: readonly OpsSignalKind[] };

type Mode =
  | { mode: "spike"; windowMs: number; threshold: number }
  | { mode: "any" };

type RuleShape = { key: string } & Source & Mode;

export const ALERT_RULES = [
  {
    key: "login-failed-spike",
    source: "audit",
    types: ["LOGIN_FAILED"],
    mode: "spike",
    windowMs: 15 * MINUTE_MS,
    threshold: 50,
  },
  {
    key: "account-locked-spike",
    source: "audit",
    types: ["ACCOUNT_LOCKED"],
    mode: "spike",
    windowMs: HOUR_MS,
    threshold: 5,
  },
  {
    key: "break-glass",
    source: "audit",
    types: ["BREAK_GLASS_PA_RECOVERY"],
    mode: "any",
  },
  {
    key: "pa-transfer-initiated",
    source: "audit",
    types: ["PA_TRANSFER_INITIATED"],
    mode: "any",
  },
  {
    key: "jwks-rotated",
    source: "audit",
    types: ["JWKS_ROTATED"],
    mode: "any",
  },
  {
    key: "job-failed",
    source: "signal",
    kinds: ["JOB_FAILED"],
    mode: "any",
  },
  {
    key: "upstash-fail-open",
    source: "signal",
    kinds: ["RATE_LIMIT_FAIL_OPEN", "EMAIL_CAP_FAIL_OPEN"],
    mode: "any",
  },
] as const satisfies readonly RuleShape[];

export type AlertRule = (typeof ALERT_RULES)[number];

export type RuleKey = AlertRule["key"];

export const RULE_KEYS = ALERT_RULES.map((rule) => rule.key) as [
  RuleKey,
  ...RuleKey[],
];

/** True when the rule's cooldown is over: it never sent, or sent long enough ago. */
export function cooldownPassed(lastSentAt: Date | null, now: Date): boolean {
  return (
    lastSentAt === null || lastSentAt.getTime() <= now.getTime() - COOLDOWN_MS
  );
}

/**
 * The half-open window `(from, now]` a rule counts events in. A spike looks
 * back its own window. An `any` rule looks back to what it last reported,
 * capped at a day.
 */
export function windowStart(
  rule: AlertRule,
  coveredThrough: Date | null,
  now: Date,
): Date {
  if (rule.mode === "spike") return new Date(now.getTime() - rule.windowMs);
  const floor = new Date(now.getTime() - ANY_LOOKBACK_CAP_MS);
  return coveredThrough && coveredThrough > floor ? coveredThrough : floor;
}

export function shouldFire(rule: AlertRule, count: number): boolean {
  return rule.mode === "spike" ? count > rule.threshold : count >= 1;
}
