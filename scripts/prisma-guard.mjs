#!/usr/bin/env node
// Guard for `migrate dev`, `migrate reset` and `db push`. See docs/MIGRATIONS.md.
// - Tooling: reads process.env directly.
// - Public repo: protected endpoints are SHA-256 hashes, not IDs.
// - Never prints a URL; at most the protected branch name.
import { createHash } from "node:crypto";
import { pathToFileURL } from "node:url";

/**
 * Neon endpoints that hand-run migration commands must never reach. Each hash
 * is SHA-256 of the lowercased endpoint ID, without `-pooler` or the domain.
 */
export const PROTECTED_ENDPOINTS = Object.freeze([
  Object.freeze({
    branch: "main",
    sha256: "f68ff4c27eba428b237a709de8692b085af0a23e499e8328a38d935711dd0dfa",
  }),
  Object.freeze({
    branch: "dev",
    sha256: "da1e1fa340335cb44377ba8c76d4d535650af75c0159d91e36054fdadec8d984",
  }),
]);

/** `SGAUTH_ENV` values whose deployments only ever run `migrate deploy`. */
export const PROTECTED_ENVS = ["production", "dev"];

export const GUARDED_COMMANDS = [
  ["migrate", "dev"],
  ["migrate", "reset"],
  ["db", "push"],
];

/**
 * The Neon endpoint ID of a host name: lowercase, first DNS label, without a
 * trailing `-pooler`.
 */
export function endpointId(hostname) {
  const label = hostname.trim().toLowerCase().split(".")[0];
  return label.endsWith("-pooler") ? label.slice(0, -"-pooler".length) : label;
}

export function hashEndpoint(id) {
  return createHash("sha256").update(id, "utf8").digest("hex");
}

/**
 * The guarded command in `args` (for example `"migrate dev"`), or `null`. The
 * pair may sit anywhere in `args`, so flags around it do not hide it.
 */
export function guardedCommand(args) {
  for (const [first, second] of GUARDED_COMMANDS) {
    for (let i = 0; i < args.length - 1; i += 1) {
      if (args[i] === first && args[i + 1] === second) {
        return `${first} ${second}`;
      }
    }
  }
  return null;
}

function refusal(command, reason) {
  return new Error(
    `prisma-guard: refusing "prisma ${command}": ${reason}. Use a personal Neon branch; see docs/MIGRATIONS.md.`,
  );
}

/**
 * Returns `null` when `args` may run, and throws when they are refused.
 * `protectedEndpoints` exists so tests can inject a fake endpoint.
 */
export function checkPrismaCommand(
  args,
  env,
  { protectedEndpoints = PROTECTED_ENDPOINTS } = {},
) {
  const command = guardedCommand(args);
  if (command === null) return null;

  if (PROTECTED_ENVS.includes(env.SGAUTH_ENV)) {
    throw refusal(command, `SGAUTH_ENV is "${env.SGAUTH_ENV}"`);
  }
  if (env.VERCEL_ENV) {
    throw refusal(
      command,
      `this is a Vercel build (VERCEL_ENV="${env.VERCEL_ENV}"); builds run prisma migrate deploy only`,
    );
  }
  if (!env.DIRECT_URL) {
    throw refusal(command, "DIRECT_URL is not set");
  }
  let hostname;
  try {
    hostname = new URL(env.DIRECT_URL).hostname;
  } catch {
    // The parser's message can contain the URL, so it is never echoed.
    throw refusal(command, "DIRECT_URL is not a valid URL");
  }

  const id = endpointId(hostname);
  const hash = hashEndpoint(id);
  const protectedEndpoint = protectedEndpoints.find(
    (entry) => entry.sha256 === hash,
  );
  if (protectedEndpoint) {
    throw refusal(
      command,
      `DIRECT_URL points at the Neon ${protectedEndpoint.branch} branch`,
    );
  }

  const extra = (env.SGAUTH_PROTECTED_DB_HOSTS ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(endpointId);
  if (extra.includes(id)) {
    throw refusal(
      command,
      "DIRECT_URL host is listed in SGAUTH_PROTECTED_DB_HOSTS",
    );
  }
  return null;
}

async function main() {
  // Load `.env` the way prisma.config.ts does, so the guard sees the same
  // DIRECT_URL Prisma will. dotenv never overrides variables already set.
  await import("dotenv/config");
  try {
    checkPrismaCommand(process.argv.slice(2), process.env);
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) main();
