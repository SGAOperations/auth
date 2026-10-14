#!/usr/bin/env node
// Vercel build entry point (`buildCommand` in vercel.json). Checks that the
// Vercel environment variables are consistent before anything touches the
// database, then runs `prisma generate`, `prisma migrate deploy` and
// `next build` in order.
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
 * @returns {URL} the parsed direct URL, for the host-only log line
 */
export function checkDatabaseUrls(env) {
  for (const name of ["DATABASE_URL", "DIRECT_URL"]) {
    if (!env[name]) throw new Error(`${name} is not set`);
  }
  const pooled = parseUrl("DATABASE_URL", env.DATABASE_URL);
  const direct = parseUrl("DIRECT_URL", env.DIRECT_URL);

  const pooledMode = pooled.searchParams.get("sslmode");
  if (pooledMode !== "verify-full") {
    throw new Error(
      `DATABASE_URL must use sslmode=verify-full (found sslmode=${pooledMode ?? "none"})`,
    );
  }
  const directMode = direct.searchParams.get("sslmode");
  const strictFallback =
    directMode === "require" &&
    direct.searchParams.get("sslaccept") === "strict";
  if (directMode !== "verify-full" && !strictFallback) {
    throw new Error(
      `DIRECT_URL must use sslmode=verify-full, or sslmode=require with sslaccept=strict (found sslmode=${directMode ?? "none"})`,
    );
  }
  return direct;
}

export function checkEnv(env) {
  const vercelEnv = env.VERCEL_ENV;
  const ref = env.VERCEL_GIT_COMMIT_REF;
  const expected = expectedSgauthEnv(vercelEnv, ref);
  if (env.SGAUTH_ENV !== expected) {
    throw new Error(
      `SGAUTH_ENV is "${env.SGAUTH_ENV ?? ""}" but this ${vercelEnv} build of ${ref ?? ""} expects "${expected}"; fix the Vercel env scope (see docs/ENVIRONMENTS.md)`,
    );
  }
  const direct = checkDatabaseUrls(env);
  console.log(
    `vercel-build: SGAUTH_ENV=${env.SGAUTH_ENV} VERCEL_ENV=${vercelEnv} ref=${ref ?? ""} database host=${direct.hostname}`,
  );
}

const STEPS = [
  ["prisma", "generate"],
  ["prisma", "migrate", "deploy"],
  ["next", "build"],
];

function main() {
  try {
    checkEnv(process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
  for (const [bin, ...args] of STEPS) {
    const result = spawnSync("npx", ["--no-install", bin, ...args], {
      stdio: "inherit",
      shell: false,
    });
    if (result.status !== 0) process.exit(result.status ?? 1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
