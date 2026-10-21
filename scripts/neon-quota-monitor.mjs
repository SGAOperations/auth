#!/usr/bin/env node
// Neon Free-plan quota monitor: emails (Resend) at 50/70/85/100% of the 100
// CU-hour monthly quota, with a projected exhaustion date. 85% is the upgrade
// trigger in docs/runbooks/neon-upgrade.md.
// State file (Actions cache) records sent thresholds; written only after a
// successful send, never in test mode. Unreadable usage fails the run.
// CI tooling, so it reads process.env directly (the env.ts rule is app-only).
//
// Usage: NEON_API_KEY=... NEON_PROJECT_ID=... RESEND_API_KEY=... NEON_QUOTA_ALERT_TO=a@x,b@x \
//   node scripts/neon-quota-monitor.mjs [--dry-run] [--quota-cu-hours <n>] [--state <path>]
import {
  appendFileSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import { pathToFileURL } from "node:url";

export const QUOTA_CU_HOURS = 100;
export const THRESHOLDS = [50, 70, 85, 100];
export const UPGRADE_TRIGGER = 85;
export const DEFAULT_FROM = "SGA Auth <no-reply@auth.northeasternsga.com>";
export const RUNBOOK_URL =
  "https://github.com/SGAOperations/auth/blob/dev/docs/runbooks/neon-upgrade.md";

const DAY_MS = 86_400_000;
const HOUR_MS = 3_600_000;
const API_BASE = "https://console.neon.tech/api/v2";
const RESEND_URL = "https://api.resend.com/emails";

/**
 * Read compute usage from the `project` object of `GET /projects/{id}`.
 * `compute_time_seconds` counts CU-seconds, so 0.25 CU for 1 s adds 0.25.
 * Throws on any missing or invalid field: nothing is ever alerted on a guess.
 * @returns {{ cuHours: number, periodStart: Date, periodEnd: Date }}
 */
export function parseUsage(project) {
  const seconds = project?.compute_time_seconds;
  if (typeof seconds !== "number" || !Number.isFinite(seconds) || seconds < 0) {
    throw new Error(
      `compute_time_seconds is missing or invalid: ${JSON.stringify(seconds)}`,
    );
  }
  const date = (field) => {
    const raw = project?.[field];
    const parsed = typeof raw === "string" ? new Date(raw) : null;
    if (!parsed || Number.isNaN(parsed.getTime())) {
      throw new Error(`${field} is missing or invalid: ${JSON.stringify(raw)}`);
    }
    return parsed;
  };
  const periodStart = date("consumption_period_start");
  const periodEnd = date("consumption_period_end");
  if (periodEnd <= periodStart) {
    throw new Error("consumption period ends before it starts");
  }
  return { cuHours: seconds / 3600, periodStart, periodEnd };
}

/**
 * Linear projection of when the quota runs out. `exhaustsAt` is null with no
 * usage or under one hour of the period elapsed, since a rate from that little
 * data is noise.
 * @returns {{ percent: number, ratePerDay: number, exhaustsAt: Date | null, beforeReset: boolean }}
 */
export function project({ cuHours, quota, periodStart, periodEnd, now }) {
  const percent = (cuHours / quota) * 100;
  const elapsedMs = now - periodStart.getTime();
  if (cuHours <= 0 || elapsedMs < HOUR_MS) {
    return { percent, ratePerDay: 0, exhaustsAt: null, beforeReset: false };
  }
  const ratePerDay = cuHours / (elapsedMs / DAY_MS);
  const exhaustsAt = new Date(
    periodStart.getTime() + (quota / ratePerDay) * DAY_MS,
  );
  return {
    percent,
    ratePerDay,
    exhaustsAt,
    beforeReset: exhaustsAt < periodEnd,
  };
}

/**
 * Decide whether to email. One email per run, for the highest threshold newly
 * crossed in this period; every newly crossed threshold is recorded as alerted.
 * A stored state from a different period is discarded.
 * @returns {{ send: number | null, nextState: { periodStart: string, alerted: number[] } }}
 */
export function alertDecision({ percent, state, periodStart }) {
  const period = periodStart.toISOString();
  const alerted =
    state?.periodStart === period && Array.isArray(state.alerted)
      ? state.alerted
      : [];
  const newlyCrossed = THRESHOLDS.filter(
    (t) => t <= percent && !alerted.includes(t),
  );
  if (newlyCrossed.length === 0) {
    return { send: null, nextState: { periodStart: period, alerted } };
  }
  return {
    send: Math.max(...newlyCrossed),
    nextState: {
      periodStart: period,
      alerted: [...alerted, ...newlyCrossed].sort((a, b) => a - b),
    },
  };
}

/** @returns {string[]} */
export function parseRecipients(value) {
  const entries = (value ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    throw new Error("no alert recipients configured");
  }
  for (const entry of entries) {
    if (!entry.includes("@")) {
      throw new Error(`malformed alert recipient: ${JSON.stringify(entry)}`);
    }
  }
  return entries;
}

const day = (date) => date.toISOString().slice(0, 10);

/** @returns {{ subject: string, text: string }} */
export function buildEmail({ threshold, usage, projection, quota, test }) {
  const resetDay = day(usage.periodEnd);
  const subject =
    threshold >= 100
      ? "[SGAuth] Neon quota exhausted — SGA logins are down"
      : `[SGAuth] Neon compute at ${threshold}% of the monthly Free quota`;

  let projectionLine = "Not enough data yet to project.";
  if (projection.exhaustsAt) {
    const rate = `At the current rate (${projection.ratePerDay.toFixed(1)} CU-hours/day)`;
    if (projection.beforeReset) {
      const days = Math.max(
        0,
        Math.round((usage.periodEnd - projection.exhaustsAt) / DAY_MS),
      );
      projectionLine = `${rate} the quota runs out on ${day(projection.exhaustsAt)}, ${days} days before it resets.`;
    } else {
      projectionLine = `${rate} the quota lasts until the period resets.`;
    }
  }

  let actionLine;
  if (threshold >= 100) {
    actionLine = `The compute is suspended until ${resetDay} and every SGA product's login is down. Upgrade now: ${RUNBOOK_URL}`;
  } else if (threshold >= UPGRADE_TRIGGER) {
    actionLine = `Upgrade trigger reached. Follow the upgrade runbook now; the Vice President of Operational Affairs approves the spend: ${RUNBOOK_URL}`;
  } else {
    actionLine = `No action needed yet. If usage keeps climbing, review the upgrade runbook: ${RUNBOOK_URL}`;
  }

  const text = [
    `Used ${usage.cuHours.toFixed(1)} of ${quota} CU-hours (${projection.percent.toFixed(1)}%) in the period ${day(usage.periodStart)} to ${resetDay} (UTC).`,
    projectionLine,
    actionLine,
    "",
    "Sent by the Neon quota monitor (.github/workflows/neon-quota-monitor.yml).",
  ].join("\n");

  return { subject: test ? `[TEST] ${subject}` : subject, text };
}

function readState(path) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return {};
  }
}

async function fetchProject(projectId, apiKey) {
  const res = await fetch(`${API_BASE}/projects/${projectId}`, {
    headers: { Authorization: `Bearer ${apiKey}`, Accept: "application/json" },
  });
  const text = await res.text();
  if (!res.ok) {
    throw new Error(`reading project failed: HTTP ${res.status} ${text}`);
  }
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    throw new Error("reading project failed: response was not JSON");
  }
  if (!body.project || typeof body.project !== "object") {
    throw new Error("reading project failed: response has no project");
  }
  return body.project;
}

async function sendEmail({ apiKey, from, to, subject, text }) {
  const res = await fetch(RESEND_URL, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({ from, to, subject, text }),
  });
  if (!res.ok) {
    throw new Error(
      `sending email failed: HTTP ${res.status} ${await res.text()}`,
    );
  }
}

function flagValue(args, name) {
  const index = args.indexOf(name);
  return index === -1 ? undefined : args[index + 1];
}

function requireEnv(names) {
  for (const name of names) {
    if (!process.env[name]) {
      console.error(`::error::${name} is not set`);
      process.exit(1);
    }
  }
}

async function main() {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");

  let quota = QUOTA_CU_HOURS;
  const quotaFlag = flagValue(args, "--quota-cu-hours");
  if (args.includes("--quota-cu-hours")) {
    quota = Number(quotaFlag);
    if (!quotaFlag || !Number.isFinite(quota) || quota <= 0) {
      console.error("::error::--quota-cu-hours must be a positive number");
      process.exit(1);
    }
  }
  const test = dryRun || quota !== QUOTA_CU_HOURS;
  const statePath = flagValue(args, "--state");

  requireEnv(["NEON_API_KEY", "NEON_PROJECT_ID"]);
  if (!dryRun) requireEnv(["RESEND_API_KEY", "NEON_QUOTA_ALERT_TO"]);
  const from = process.env.NEON_QUOTA_ALERT_FROM || DEFAULT_FROM;
  const resendKey = process.env.RESEND_API_KEY;

  let recipients = [];
  if (!dryRun) {
    try {
      recipients = parseRecipients(process.env.NEON_QUOTA_ALERT_TO);
    } catch (error) {
      console.error(`::error::${error.message}`);
      process.exit(1);
    }
  }

  const now = Date.now();
  let usage;
  let projection;
  try {
    const raw = await fetchProject(
      process.env.NEON_PROJECT_ID,
      process.env.NEON_API_KEY,
    );
    usage = parseUsage(raw);
    projection = project({ ...usage, quota, now });
  } catch (error) {
    console.error(`::error::Neon quota monitor failed: ${error.message}`);
    if (resendKey && recipients.length > 0 && !dryRun) {
      try {
        await sendEmail({
          apiKey: resendKey,
          from,
          to: recipients,
          subject: "[SGAuth] Neon quota monitor failed",
          text: `The Neon quota monitor could not read usage: ${error.message}\n\nCheck the run in GitHub Actions (.github/workflows/neon-quota-monitor.yml), the NEON_API_KEY secret, and docs/runbooks/on-call.md.`,
        });
      } catch (sendError) {
        console.error(`could not send the failure email: ${sendError.message}`);
      }
    }
    process.exit(1);
  }

  // A test run ignores saved state so it always emails the highest threshold
  // crossed, and never writes state back.
  const state = statePath && !test ? readState(statePath) : {};
  const decision = alertDecision({
    percent: projection.percent,
    state,
    periodStart: usage.periodStart,
  });

  let action = "no new threshold crossed";
  if (decision.send !== null) {
    const email = buildEmail({
      threshold: decision.send,
      usage,
      projection,
      quota,
      test,
    });
    if (dryRun) {
      action = `dry run: would email the ${decision.send}% alert`;
      console.log(`Subject: ${email.subject}\n\n${email.text}`);
      console.log(
        `State that would be saved: ${JSON.stringify(decision.nextState)}`,
      );
    } else {
      try {
        await sendEmail({
          apiKey: resendKey,
          from,
          to: recipients,
          ...email,
        });
      } catch (error) {
        console.error(`::error::${error.message}`);
        process.exit(1);
      }
      action = `emailed the ${decision.send}% alert to ${recipients.length} recipient(s)`;
      if (!test && statePath) {
        mkdirSync(dirname(statePath), { recursive: true });
        writeFileSync(statePath, JSON.stringify(decision.nextState));
      }
    }
  }

  const projected = projection.exhaustsAt
    ? day(projection.exhaustsAt)
    : "not enough data";
  console.log(
    `Neon quota: ${usage.cuHours.toFixed(1)} of ${quota} CU-hours (${projection.percent.toFixed(1)}%), projected exhaustion ${projected}; ${action}`,
  );
  if (projection.percent >= UPGRADE_TRIGGER) {
    console.log(
      `::warning::Neon quota is at or above the ${UPGRADE_TRIGGER}% upgrade trigger. Follow ${RUNBOOK_URL}`,
    );
  }

  if (process.env.GITHUB_STEP_SUMMARY) {
    const lines = [
      `## Neon quota monitor${test ? " (test)" : ""}`,
      "",
      "| Used | Quota | Percent | Rate | Projected exhaustion | Alerted | Action |",
      "| --- | --- | --- | --- | --- | --- | --- |",
      `| ${usage.cuHours.toFixed(1)} CU-h | ${quota} CU-h | ${projection.percent.toFixed(1)}% | ${projection.ratePerDay.toFixed(1)} CU-h/day | ${projected} | ${decision.nextState.alerted.join(", ") || "none"} | ${action} |`,
      "",
    ];
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join("\n"));
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  await main();
}
