import assert from "node:assert/strict";
import { test } from "node:test";

import {
  LEASE_KEY,
  LeaseTimeout,
  acquireLease,
  leaseProblem,
  parseArgs,
} from "./ci-test-db-lease.mjs";

const HOST = "ep-fake-host-000000";
const direct = `postgresql://migration:s3cret@${HOST}.us-east-1.aws.neon.tech/neondb`;
const pooled = `postgresql://runtime:s3cret@${HOST}-pooler.us-east-1.aws.neon.tech/neondb`;

/** A fake client whose lock is refused `refusals` times, then granted. */
function fakeClient(refusals) {
  const calls = [];
  return {
    calls,
    async query(sql, params) {
      calls.push({ sql, params });
      return { rows: [{ ok: calls.length > refusals }] };
    },
  };
}

/** A clock that only moves when the fake sleep is called. */
function fakeClock() {
  let t = 0;
  return {
    now: () => t,
    sleep: async (ms) => {
      t += ms;
    },
  };
}

test("acquires the lease after the lock is released", async () => {
  const client = fakeClient(3);
  const log = [];
  await acquireLease(client, {
    timeoutMs: 60 * 60_000,
    intervalMs: 5_000,
    log: (line) => log.push(line),
    ...fakeClock(),
  });
  assert.equal(client.calls.length, 4);
  assert.ok(client.calls.every((c) => c.params[0] === LEASE_KEY));
  assert.match(log.at(-1), /^Lease acquired after 15s\.$/);
});

test("logs a waiting line at most once a minute", async () => {
  const client = fakeClient(60); // 60 polls x 5 s = 5 minutes
  const log = [];
  await acquireLease(client, {
    timeoutMs: 60 * 60_000,
    intervalMs: 5_000,
    log: (line) => log.push(line),
    ...fakeClock(),
  });
  const waiting = log.filter((line) => line.startsWith("Waiting"));
  assert.equal(waiting.length, 5);
  assert.match(waiting[0], /1 min so far\.$/);
  assert.match(waiting[4], /5 min so far\.$/);
});

test("throws LeaseTimeout once the timeout has passed", async () => {
  const client = fakeClient(Infinity);
  await assert.rejects(
    acquireLease(client, {
      timeoutMs: 60_000,
      intervalMs: 5_000,
      log: () => {},
      ...fakeClock(),
    }),
    LeaseTimeout,
  );
  assert.equal(client.calls.length, 13);
});

test("a direct URL can hold a lease", () => {
  assert.equal(leaseProblem({ TEST_DIRECT_URL: direct }), null);
});

test("refuses a missing, invalid or pooled URL", () => {
  assert.equal(leaseProblem({}), "TEST_DIRECT_URL is not set");
  assert.equal(
    leaseProblem({ TEST_DIRECT_URL: "nope" }),
    "TEST_DIRECT_URL is not a valid URL",
  );
  assert.equal(
    leaseProblem({ TEST_DIRECT_URL: pooled }),
    "TEST_DIRECT_URL is a pooled URL; the lease needs a direct connection",
  );
});

test("never puts the password or hostname in a message", () => {
  for (const url of ["nope", pooled]) {
    const problem = leaseProblem({ TEST_DIRECT_URL: url });
    assert.ok(!problem.includes("s3cret"));
    assert.ok(!problem.includes(HOST));
  }
});

test("parseArgs returns the command after the separator", () => {
  assert.deepEqual(parseArgs(["--", "bash", "-ec", "echo hi"]), {
    command: "bash",
    args: ["-ec", "echo hi"],
  });
});

test("parseArgs rejects an empty command", () => {
  const usage =
    "usage: node scripts/ci-test-db-lease.mjs -- <command> [args...]";
  assert.throws(() => parseArgs([]), { message: usage });
  assert.throws(() => parseArgs(["--"]), { message: usage });
});
