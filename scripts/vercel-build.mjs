#!/usr/bin/env node
// Vercel build entry point (`buildCommand` in vercel.json). Checks that the
// Vercel environment variables are consistent before anything touches the
// database, then runs `prisma generate`, `prisma migrate deploy` and
// `next build` in order.
//
// Only Production and the Preview of branch `dev` run `migrate deploy`. Every
// other Preview skips it, so a pushed branch's migration never lands on a
// shared database by accident. This is not a security boundary: a branch can
// edit this file. The boundary is that Preview (all branches) holds no
// credential for Neon `main` or `dev` (docs/ENVIRONMENTS.md).
//
// This is build tooling that runs only on Vercel, so it reads `process.env`
// directly. The `src/lib/env.ts` rule in docs/ENGINEERING.md section 2 covers
// application code only.
//
// Nothing here may print a credential: the database check reports variable
// names and the `sslmode` value, and the log line carries the direct host
// name only, never the user, password, query string or full URL.
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

/**
 * The `SGAUTH_ENV` value this Vercel build must run with.
 * @returns {string} expected value, or throws when not a Vercel build
 */
export function expectedSgauthEnv(vercelEnv, ref) {
  if (vercelEnv === "production") return "production";
  if (vercelEnv === "preview") return ref === "dev" ? "dev" : "preview";
  throw new Error(
    `vercel-build.mjs runs only on Vercel builds (VERCEL_ENV="${vercelEnv ?? ""}")`,
  );
}

/**
 * Whether this Vercel build applies migrations: Production, and the Preview
 * of branch `dev`. Call only after `expectedSgauthEnv` accepted the build.
 */
export function shouldMigrate(vercelEnv, ref) {
  return (
    vercelEnv === "production" || (vercelEnv === "preview" && ref === "dev")
  );
}

/** Stands in for an absent `DIRECT_URL` so `prisma.config.ts` loads for
 * `prisma generate`, which never connects. */
export const PLACEHOLDER_DIRECT_URL = "postgresql://placeholder";

function parseUrl(name, value) {
  try {
    return new URL(value);
  } catch {
    // The parser's message can contain the URL, so it is never echoed.
    throw new Error(`${name} is not a valid URL`);
  }
}

/**
 * `DATABASE_URL` needs `sslmode=verify-full`. `DIRECT_URL` may instead use
 * `sslmode=require` together with `sslaccept=strict` (the fallback from the
 * Prisma/Neon setup, used only if the migration CLI rejects `verify-full`).
 * `DIRECT_URL` is required only when the build migrates; a build that does
 * not may leave it unset, and a value that is set is still checked.
 * @returns {{ pooled: URL, direct: URL | null }} the parsed URLs, for the
 *   host-only log line
 */
export function checkDatabaseUrls(env, { requireDirect = true } = {}) {
  if (!env.DATABASE_URL) throw new Error("DATABASE_URL is not set");
  if (requireDirect && !env.DIRECT_URL) {
    throw new Error("DIRECT_URL is not set");
  }
  const pooled = parseUrl("DATABASE_URL", env.DATABASE_URL);

  const pooledMode = pooled.searchParams.get("sslmode");
  if (pooledMode !== "verify-full") {
    throw new Error(
      `DATABASE_URL must use sslmode=verify-full (found sslmode=${pooledMode ?? "none"})`,
    );
  }
  if (!env.DIRECT_URL) return { pooled, direct: null };

  const direct = parseUrl("DIRECT_URL", env.DIRECT_URL);
  const directMode = direct.searchParams.get("sslmode");
  const strictFallback =
    directMode === "require" &&
    direct.searchParams.get("sslaccept") === "strict";
  if (directMode !== "verify-full" && !strictFallback) {
    throw new Error(
      `DIRECT_URL must use sslmode=verify-full, or sslmode=require with sslaccept=strict (found sslmode=${directMode ?? "none"})`,
    );
  }
  return { pooled, direct };
}

/**
 * Validates the build's environment and logs one line about it.
 * @returns {{ migrate: boolean }} whether this build runs `migrate deploy`
 */
export function checkEnv(env, log = console.log) {
  const vercelEnv = env.VERCEL_ENV;
  const ref = env.VERCEL_GIT_COMMIT_REF;
  const expected = expectedSgauthEnv(vercelEnv, ref);
  if (env.SGAUTH_ENV !== expected) {
    throw new Error(
      `SGAUTH_ENV is "${env.SGAUTH_ENV ?? ""}" but this ${vercelEnv} build of ${ref ?? ""} expects "${expected}"; fix the Vercel env scope (see docs/ENVIRONMENTS.md)`,
    );
  }
  const migrate = shouldMigrate(vercelEnv, ref);
  const { pooled, direct } = checkDatabaseUrls(env, { requireDirect: migrate });
  log(
    `vercel-build: SGAUTH_ENV=${env.SGAUTH_ENV} VERCEL_ENV=${vercelEnv} ref=${ref ?? ""} database host=${(direct ?? pooled).hostname}`,
  );
  if (!migrate) {
    log(
      `vercel-build: skipping prisma migrate deploy: only Production and the dev branch apply migrations, and this is a Preview of ${ref ?? ""}`,
    );
  }
  return { migrate };
}

/**
 * The commands this build runs, in order, each as `[bin, ...args]`.
 */
export function buildSteps({ migrate }) {
  return [
    ["prisma", "generate"],
    ...(migrate ? [["prisma", "migrate", "deploy"]] : []),
    ["next", "build"],
  ];
}

function main() {
  let plan;
  try {
    plan = checkEnv(process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  // prisma.config.ts reads DIRECT_URL even for `generate`, which never
  // connects, so a build without one gets a placeholder.
  const env = process.env.DIRECT_URL
    ? process.env
    : { ...process.env, DIRECT_URL: PLACEHOLDER_DIRECT_URL };
  for (const [bin, ...args] of buildSteps(plan)) {
    const result = spawnSync("npx", ["--no-install", bin, ...args], {
      stdio: "inherit",
      shell: false,
      env,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
