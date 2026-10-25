import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  ALERT_RULES,
  COOLDOWN_MS,
  cooldownPassed,
  shouldFire,
  windowStart,
  type AlertRule,
  type RuleKey,
} from "@/lib/alerts/rules";
import type { Mailer, MailerLog } from "@/lib/email/mailer";
import type { TemplateData } from "@/lib/email/templates";

// The security-alert job. Each rule keeps one AlertState row. A rule that fires
// is claimed with a single atomic upsert, so two overlapping or retried runs
// send at most once. One run sends one summary email per admin, covering every
// rule it claimed. Claims are released when nothing was delivered, so a failed
// run does not silence the next one.

export type AlertDb = Pick<
  PrismaClient,
  "alertState" | "auditEvent" | "opsSignal" | "user" | "$queryRaw"
>;

export interface AlertRunOptions {
  db: AlertDb;
  mailer: Mailer;
  log: Pick<MailerLog, "info" | "error">;
  now?: Date;
}

// A type alias, so it is assignable to a job's result record.
export type AlertRunResult = {
  fired: RuleKey[];
  suppressed: RuleKey[];
  sent: number;
  capped: number;
  failed: number;
};

type AlertItem = TemplateData<"security-alert">["items"][number];

type Candidate = { rule: AlertRule; item: AlertItem };

type PreviousState = { lastSentAt: Date | null; coveredThrough: Date | null };

const MAX_JOBS_LISTED = 5;

async function countFor(
  db: AlertDb,
  rule: AlertRule,
  from: Date,
  now: Date,
): Promise<{ count: number; since: Date | null }> {
  const createdAt = { gt: from, lte: now };
  const aggregate =
    rule.source === "audit"
      ? await db.auditEvent.aggregate({
          where: { type: { in: [...rule.types] }, createdAt },
          _count: true,
          _min: { createdAt: true },
        })
      : await db.opsSignal.aggregate({
          where: { kind: { in: [...rule.kinds] }, createdAt },
          _count: true,
          _min: { createdAt: true },
        });
  return { count: aggregate._count, since: aggregate._min.createdAt };
}

async function failedJobs(
  db: AlertDb,
  from: Date,
  now: Date,
): Promise<string[]> {
  const rows = await db.opsSignal.findMany({
    where: { kind: "JOB_FAILED", createdAt: { gt: from, lte: now } },
    select: { detail: true },
    orderBy: { createdAt: "asc" },
    take: 200,
  });
  const jobs = new Set<string>();
  for (const { detail } of rows) {
    const job =
      detail && typeof detail === "object" && !Array.isArray(detail)
        ? detail.job
        : undefined;
    if (typeof job === "string") jobs.add(job);
  }
  return [...jobs].slice(0, MAX_JOBS_LISTED);
}

async function evaluate(
  db: AlertDb,
  rule: AlertRule,
  previous: PreviousState | undefined,
  now: Date,
): Promise<Candidate | null> {
  const from = windowStart(rule, previous?.coveredThrough ?? null, now);
  const { count, since } = await countFor(db, rule, from, now);
  if (!shouldFire(rule, count)) return null;

  const item: AlertItem = {
    rule: rule.key,
    count,
    ...(rule.mode === "any" && since ? { since } : {}),
  };
  if (rule.key === "job-failed") {
    const jobs = await failedJobs(db, from, now);
    if (jobs.length > 0) item.jobs = jobs;
  }
  return { rule, item };
}

/** True when this run took the rule: no row, a cooled-down row, and nobody else got there first. */
async function claim(db: AlertDb, key: string, now: Date): Promise<boolean> {
  const cutoff = new Date(now.getTime() - COOLDOWN_MS);
  const rows = await db.$queryRaw<{ ruleKey: string }[]>`
    INSERT INTO "AlertState" ("ruleKey", "lastSentAt", "coveredThrough")
    VALUES (${key}, ${now}, ${now})
    ON CONFLICT ("ruleKey") DO UPDATE
      SET "lastSentAt" = EXCLUDED."lastSentAt",
          "coveredThrough" = EXCLUDED."coveredThrough"
      WHERE "AlertState"."lastSentAt" IS NULL
         OR "AlertState"."lastSentAt" <= ${cutoff}
    RETURNING "ruleKey"`;
  return rows.length > 0;
}

/** Puts a claimed rule back as it was. Matching on `now` leaves a later run's claim alone. */
async function release(
  db: AlertDb,
  key: string,
  previous: PreviousState | undefined,
  now: Date,
): Promise<void> {
  if (previous) {
    await db.alertState.updateMany({
      where: { ruleKey: key, lastSentAt: now },
      data: {
        lastSentAt: previous.lastSentAt,
        coveredThrough: previous.coveredThrough,
      },
    });
  } else {
    await db.alertState.deleteMany({
      where: { ruleKey: key, lastSentAt: now },
    });
  }
}

// The template rejects a name with control characters or over 100 characters,
// and a rejected message would fail the whole run.
function safeName(user: {
  name: string;
  preferredName: string | null;
}): string | undefined {
  const raw = (user.preferredName ?? user.name)
    .replace(/[\u0000-\u001f\u007f-\u009f]/g, " ")
    .trim()
    .slice(0, 100)
    .trim();
  return raw || undefined;
}

export async function runSecurityAlerts({
  db,
  mailer,
  log,
  now = new Date(),
}: AlertRunOptions): Promise<AlertRunResult> {
  const states = new Map<string, PreviousState>(
    (await db.alertState.findMany()).map((row) => [
      row.ruleKey,
      { lastSentAt: row.lastSentAt, coveredThrough: row.coveredThrough },
    ]),
  );

  const suppressed: RuleKey[] = [];
  const candidates: Candidate[] = [];
  for (const rule of ALERT_RULES) {
    const previous = states.get(rule.key);
    // Before counting, so a rule in its cooldown costs no query.
    if (!cooldownPassed(previous?.lastSentAt ?? null, now)) {
      suppressed.push(rule.key);
      continue;
    }
    const candidate = await evaluate(db, rule, previous, now);
    if (candidate) candidates.push(candidate);
  }

  const claimed: Candidate[] = [];
  for (const candidate of candidates) {
    if (await claim(db, candidate.rule.key, now)) claimed.push(candidate);
    else suppressed.push(candidate.rule.key);
  }

  const result: AlertRunResult = {
    fired: claimed.map(({ rule }) => rule.key),
    suppressed,
    sent: 0,
    capped: 0,
    failed: 0,
  };
  if (claimed.length === 0) {
    log.info("security_alerts_run", { ...result, recipients: 0 });
    return result;
  }

  const releaseAll = () =>
    Promise.all(
      claimed.map(({ rule }) =>
        release(db, rule.key, states.get(rule.key), now),
      ),
    );

  const recipients = await db.user.findMany({
    where: { isAdmin: true, status: "ACTIVE", emailVerified: true },
    select: { email: true, name: true, preferredName: true },
  });

  try {
    for (const recipient of recipients) {
      const outcome = await mailer.sendEmail({
        to: recipient.email,
        template: "security-alert",
        data: {
          name: safeName(recipient),
          checkedAt: now,
          items: claimed.map(({ item }) => item),
        },
      });
      if (outcome.status === "sent") result.sent += 1;
      else if (outcome.status === "capped") result.capped += 1;
      else result.failed += 1;
    }
  } catch (error) {
    await releaseAll();
    throw error;
  }

  // Partial delivery keeps the claim. Nothing delivered releases it, so the
  // next run tries again.
  if (result.sent === 0) {
    await releaseAll();
    const reason = recipients.length === 0 ? "no-recipients" : "send-failed";
    log.error("[ALERT] security alert not delivered", {
      rules: result.fired,
      reason,
    });
    throw new Error("security alert not delivered");
  }

  log.info("security_alerts_run", { ...result, recipients: recipients.length });
  return result;
}
