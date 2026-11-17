// Runs a command while holding a Postgres session advisory lock on the CI test
// database, so two CI runs never reset or use the same Neon test branch at the
// same time. ci.yml wraps the reset and the vitest run in it instead of a
// GitHub concurrency group, which cancels all but one waiting job.
//
// Usage: node scripts/ci-test-db-lease.mjs -- <command> [args...]
//
// The lock is released when the child exits, or by Postgres itself when the
// connection drops, so there is no TTL and nothing to clean up. It must be a
// direct connection: a pooled one runs in transaction mode, where session
// advisory locks are not reliable. Messages never include the URL.
import { spawn } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

// The CI test-database lease. One key serves every Neon branch, because each
// branch is its own database.
export const LEASE_KEY = 7370370370n;

const USAGE = "usage: node scripts/ci-test-db-lease.mjs -- <command> [args...]";
const POLL_INTERVAL_MS = 5_000;
const LOG_INTERVAL_MS = 60_000;
const KEEP_ALIVE_MS = 30_000;
const DEFAULT_TIMEOUT_MINUTES = 30;

export class LeaseTimeout extends Error {
  constructor() {
    super("timed out waiting for the test database lease");
    this.name = "LeaseTimeout";
  }
}

/** The command and arguments after `--`. */
export function parseArgs(argv) {
  const separator = argv.indexOf("--");
  const rest = separator === -1 ? [] : argv.slice(separator + 1);
  if (rest.length === 0) throw new Error(USAGE);
  const [command, ...args] = rest;
  return { command, args };
}

/** The first problem with TEST_DIRECT_URL, or null when it can hold a lease. */
export function leaseProblem(env) {
  const raw = env.TEST_DIRECT_URL;
  if (!raw) return "TEST_DIRECT_URL is not set";
  let url;
  try {
    url = new URL(raw);
  } catch {
    return "TEST_DIRECT_URL is not a valid URL";
  }
  if (url.hostname.includes("-pooler")) {
    return "TEST_DIRECT_URL is a pooled URL; the lease needs a direct connection";
  }
  return null;
}

/**
 * Polls pg_try_advisory_lock until it is won. Waits `intervalMs` between
 * attempts, logs at most once a minute, and throws LeaseTimeout after
 * `timeoutMs`.
 */
export async function acquireLease(
  client,
  {
    key = LEASE_KEY,
    timeoutMs,
    intervalMs = POLL_INTERVAL_MS,
    sleep = delay,
    now = Date.now,
    log = console.log,
  },
) {
  const start = now();
  let lastLog = start;
  for (;;) {
    const { rows } = await client.query(
      "SELECT pg_try_advisory_lock($1) AS ok",
      [key],
    );
    if (rows[0].ok === true) {
      log(`Lease acquired after ${Math.round((now() - start) / 1000)}s.`);
      return;
    }
    if (now() - start >= timeoutMs) throw new LeaseTimeout();
    await sleep(intervalMs);
    if (now() - lastLog >= LOG_INTERVAL_MS) {
      lastLog = now();
      log(
        `Waiting for the test database lease (another CI run holds it), ${Math.floor((now() - start) / 60_000)} min so far.`,
      );
    }
  }
}

/** Runs the child to completion; resolves with its exit code (1 for a signal). */
function runChild({ command, args }, client) {
  return new Promise((resolve) => {
    const child = spawn(command, args, { stdio: "inherit", env: process.env });
    let leaseLost = false;

    const loseLease = () => {
      if (leaseLost) return;
      leaseLost = true;
      console.error(
        "::error::Lost the test database lease connection; stopping the run so it cannot overlap another.",
      );
      child.kill("SIGTERM");
    };

    // Fail closed: once the connection drops, another run may take the lock.
    client.on("error", loseLease);
    const keepAlive = setInterval(() => {
      client.query("SELECT 1").catch(loseLease);
    }, KEEP_ALIVE_MS);

    for (const signal of ["SIGINT", "SIGTERM"]) {
      process.on(signal, () => child.kill(signal));
    }

    child.on("error", (err) => {
      clearInterval(keepAlive);
      console.error(
        `::error::Could not start ${command}: ${err.code ?? "error"}`,
      );
      resolve(1);
    });
    child.on("close", (code) => {
      clearInterval(keepAlive);
      resolve(leaseLost ? 1 : (code ?? 1));
    });
  });
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  let invocation;
  try {
    invocation = parseArgs(argv);
  } catch (err) {
    console.error(err.message);
    return 1;
  }

  const problem = leaseProblem(env);
  if (problem) {
    console.error(`::error::${problem}.`);
    return 1;
  }

  // Loaded here, not at the top: the script-tests job runs the pure helpers
  // above without installing dependencies.
  const { default: pg } = await import("pg");
  const minutes =
    Number(env.CI_LEASE_TIMEOUT_MINUTES) || DEFAULT_TIMEOUT_MINUTES;
  const client = new pg.Client({
    connectionString: env.TEST_DIRECT_URL,
    keepAlive: true,
    application_name: "sgauth-ci-lease",
  });
  // An error while connecting or waiting rejects the pending query; once the
  // child runs, runChild replaces this handler.
  client.on("error", () => {});

  try {
    await client.connect();
  } catch (err) {
    console.error(
      `::error::Could not connect to the test database to take the lease: ${err.code ?? err.message}`,
    );
    return 1;
  }

  try {
    await acquireLease(client, { timeoutMs: minutes * 60_000 });
  } catch (err) {
    if (err instanceof LeaseTimeout) {
      console.error(
        `::error::Timed out after ${minutes} minutes waiting for the test database lease. Another CI run is still using this Neon branch; re-run this job.`,
      );
    } else {
      console.error(
        `::error::Could not take the test database lease: ${err.code ?? "connection error"}`,
      );
    }
    client.end().catch(() => {});
    return 1;
  }

  const code = await runChild(invocation, client);
  try {
    await client.query("SELECT pg_advisory_unlock($1)", [LEASE_KEY]);
  } catch {
    // The connection is gone, so Postgres has already released the lock.
  }
  await client.end().catch(() => {});
  return code;
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exit(await main());
}
