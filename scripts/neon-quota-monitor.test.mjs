import assert from "node:assert/strict";
import { test } from "node:test";

import {
  RUNBOOK_URL,
  alertDecision,
  buildEmail,
  parseRecipients,
  parseUsage,
  project,
} from "./neon-quota-monitor.mjs";

const DAY = 86_400_000;
const PERIOD_START = new Date("2026-10-01T00:00:00Z");
const PERIOD_END = new Date("2026-11-01T00:00:00Z");
const NOW = Date.parse("2026-10-11T00:00:00Z"); // 10 days into the period

const validProject = (extra = {}) => ({
  compute_time_seconds: 36_000,
  consumption_period_start: PERIOD_START.toISOString(),
  consumption_period_end: PERIOD_END.toISOString(),
  ...extra,
});

test("parseUsage converts CU-seconds to CU-hours and reads the period", () => {
  const usage = parseUsage(validProject({ compute_time_seconds: 36_000 }));
  assert.equal(usage.cuHours, 10);
  assert.equal(usage.periodStart.toISOString(), PERIOD_START.toISOString());
  assert.equal(usage.periodEnd.toISOString(), PERIOD_END.toISOString());
});

test("parseUsage fails closed on every missing or invalid field", () => {
  const bad = [
    validProject({ compute_time_seconds: undefined }),
    validProject({ compute_time_seconds: "36000" }),
    validProject({ compute_time_seconds: -1 }),
    validProject({ compute_time_seconds: Number.NaN }),
    validProject({ consumption_period_start: undefined }),
    validProject({ consumption_period_start: "not a date" }),
    validProject({ consumption_period_end: undefined }),
    validProject({ consumption_period_end: "garbage" }),
    validProject({ consumption_period_end: PERIOD_START.toISOString() }),
    undefined,
  ];
  for (const input of bad) {
    assert.throws(() => parseUsage(input));
  }
});

test("project computes the rate and the exhaustion date", () => {
  const result = project({
    cuHours: 20,
    quota: 100,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    now: NOW,
  });
  assert.equal(result.percent, 20);
  assert.equal(result.ratePerDay, 2);
  assert.equal(
    result.exhaustsAt.toISOString(),
    new Date(PERIOD_START.getTime() + 50 * DAY).toISOString(),
  );
  assert.equal(result.beforeReset, false);
});

test("project flags exhaustion before the period resets", () => {
  const result = project({
    cuHours: 50,
    quota: 100,
    periodStart: PERIOD_START,
    periodEnd: PERIOD_END,
    now: NOW,
  });
  assert.equal(result.ratePerDay, 5);
  assert.equal(
    result.exhaustsAt.toISOString(),
    new Date(PERIOD_START.getTime() + 20 * DAY).toISOString(),
  );
  assert.equal(result.beforeReset, true);
});

test("project has no exhaustion date without usage or enough elapsed time", () => {
  const base = { quota: 100, periodStart: PERIOD_START, periodEnd: PERIOD_END };
  const noUsage = project({ ...base, cuHours: 0, now: NOW });
  assert.equal(noUsage.exhaustsAt, null);
  assert.equal(noUsage.beforeReset, false);
  const tooSoon = project({
    ...base,
    cuHours: 5,
    now: PERIOD_START.getTime() + 30 * 60_000,
  });
  assert.equal(tooSoon.exhaustsAt, null);
});

test("alertDecision sends the 50% alert on the first crossing", () => {
  const decision = alertDecision({
    percent: 52,
    state: {},
    periodStart: PERIOD_START,
  });
  assert.equal(decision.send, 50);
  assert.deepEqual(decision.nextState, {
    periodStart: PERIOD_START.toISOString(),
    alerted: [50],
  });
});

test("alertDecision sends one email when usage skips thresholds", () => {
  const decision = alertDecision({
    percent: 72,
    state: {},
    periodStart: PERIOD_START,
  });
  assert.equal(decision.send, 70);
  assert.deepEqual(decision.nextState.alerted, [50, 70]);
});

test("alertDecision does not repeat an alert the next day", () => {
  const decision = alertDecision({
    percent: 74,
    state: { periodStart: PERIOD_START.toISOString(), alerted: [50, 70] },
    periodStart: PERIOD_START,
  });
  assert.equal(decision.send, null);
  assert.deepEqual(decision.nextState.alerted, [50, 70]);
});

test("alertDecision escalates to 85% and then 100%", () => {
  const period = PERIOD_START.toISOString();
  const at85 = alertDecision({
    percent: 86,
    state: { periodStart: period, alerted: [50, 70] },
    periodStart: PERIOD_START,
  });
  assert.equal(at85.send, 85);
  const at100 = alertDecision({
    percent: 100,
    state: at85.nextState,
    periodStart: PERIOD_START,
  });
  assert.equal(at100.send, 100);
  assert.deepEqual(at100.nextState.alerted, [50, 70, 85, 100]);
});

test("alertDecision starts fresh in a new period", () => {
  const next = new Date("2026-11-01T00:00:00Z");
  const decision = alertDecision({
    percent: 51,
    state: { periodStart: PERIOD_START.toISOString(), alerted: [50, 70, 85] },
    periodStart: next,
  });
  assert.equal(decision.send, 50);
  assert.deepEqual(decision.nextState, {
    periodStart: next.toISOString(),
    alerted: [50],
  });
});

test("alertDecision ignores a stale state from the previous period", () => {
  const decision = alertDecision({
    percent: 10,
    state: { periodStart: PERIOD_START.toISOString(), alerted: [50, 70] },
    periodStart: new Date("2026-11-01T00:00:00Z"),
  });
  assert.equal(decision.send, null);
  assert.deepEqual(decision.nextState.alerted, []);
});

test("parseRecipients trims entries and drops empty ones", () => {
  assert.deepEqual(parseRecipients(" a@x.edu , ,b@x.edu,"), [
    "a@x.edu",
    "b@x.edu",
  ]);
});

test("parseRecipients rejects a malformed entry and an empty list", () => {
  assert.throws(() => parseRecipients("a@x.edu, nope"), /nope/);
  assert.throws(() => parseRecipients(" , "));
  assert.throws(() => parseRecipients(undefined));
});

const usage = {
  cuHours: 52.4,
  periodStart: PERIOD_START,
  periodEnd: PERIOD_END,
};
const projectionFor = (cuHours) =>
  project({ ...usage, cuHours, quota: 100, now: NOW });

test("buildEmail for the 50% and 70% tiers needs no action", () => {
  for (const threshold of [50, 70]) {
    const { subject, text } = buildEmail({
      threshold,
      usage,
      projection: projectionFor(52.4),
      quota: 100,
      test: false,
    });
    assert.equal(
      subject,
      `[SGAuth] Neon compute at ${threshold}% of the monthly Free quota`,
    );
    assert.match(text, /Used 52\.4 of 100 CU-hours \(52\.4%\)/);
    assert.match(text, /2026-10-01 to 2026-11-01 \(UTC\)/);
    assert.match(text, /runs out on 2026-10-20, 12 days before it resets/);
    assert.match(text, /No action needed yet/);
    assert.ok(text.includes(RUNBOOK_URL));
  }
});

test("buildEmail for 85% names the upgrade trigger and the approver", () => {
  const { text } = buildEmail({
    threshold: 85,
    usage,
    projection: projectionFor(86),
    quota: 100,
    test: false,
  });
  assert.match(text, /Upgrade trigger reached/);
  assert.match(text, /Vice President of Operational Affairs/);
});

test("buildEmail for 100% says logins are down until the reset", () => {
  const { subject, text } = buildEmail({
    threshold: 100,
    usage,
    projection: projectionFor(100),
    quota: 100,
    test: false,
  });
  assert.equal(subject, "[SGAuth] Neon quota exhausted — SGA logins are down");
  assert.match(text, /suspended until 2026-11-01/);
  assert.match(text, /login is down/);
});

test("buildEmail covers the other projection lines", () => {
  const lasts = buildEmail({
    threshold: 50,
    usage,
    projection: projectionFor(20),
    quota: 100,
    test: false,
  });
  assert.match(lasts.text, /the quota lasts until the period resets/);
  const none = buildEmail({
    threshold: 50,
    usage,
    projection: projectionFor(0),
    quota: 100,
    test: false,
  });
  assert.match(none.text, /Not enough data yet to project/);
});

test("buildEmail prefixes test runs", () => {
  const { subject } = buildEmail({
    threshold: 100,
    usage,
    projection: projectionFor(100),
    quota: 0.01,
    test: true,
  });
  assert.ok(subject.startsWith("[TEST] [SGAuth] "));
});
