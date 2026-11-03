import type { SgauthEnv } from "../../src/lib/env-schema";
import {
  PROTECTED_ENDPOINTS,
  endpointId,
  hashEndpoint,
} from "../../scripts/prisma-guard.mjs";

// Pure on purpose: prisma/seed.ts runs it before any database client exists,
// so a refused run never opens a connection. Messages name variables and
// branches only, never a URL.

export class SeedRefusedError extends Error {}

export type SeedTarget = {
  sgauthEnv: SgauthEnv;
  databaseUrl: string | undefined;
  directUrl?: string | undefined;
  /** Local-only extra protected hosts, as in `SGAUTH_PROTECTED_DB_HOSTS`. */
  protectedHosts?: string | undefined;
};

type ProtectedEndpoint = { branch: string; sha256: string };

function refuse(reason: string): never {
  throw new SeedRefusedError(
    `Refusing to seed: ${reason}. Seed a personal Neon branch (README "Quick start").`,
  );
}

function hostOf(name: string, value: string): string {
  try {
    return new URL(value).hostname;
  } catch {
    // The parser's message can contain the URL, so it is never echoed.
    return refuse(`${name} is not a valid URL`);
  }
}

/**
 * Refuses production, and any URL that reaches a protected Neon endpoint
 * (the hashed list in scripts/prisma-guard.mjs). The shared `dev` endpoint is
 * seeded only with `SGAUTH_ENV=dev`: a `local` run would add its Primary Admin
 * and password there. Every other protected endpoint, `main` included, is
 * never seeded. `protectedEndpoints` exists so tests can inject a fake one.
 */
export function assertSeedAllowed(
  target: SeedTarget,
  {
    protectedEndpoints = PROTECTED_ENDPOINTS,
  }: { protectedEndpoints?: readonly ProtectedEndpoint[] } = {},
): void {
  if (target.sgauthEnv === "production") {
    throw new SeedRefusedError(
      "Refusing to seed: SGAUTH_ENV=production. The seed only runs against local, dev or preview databases. To load positions in production, use npm run positions:sync (docs/runbooks/positions-sync.md).",
    );
  }
  if (!target.databaseUrl) refuse("DATABASE_URL is not set");

  const urls: [string, string][] = [["DATABASE_URL", target.databaseUrl]];
  if (target.directUrl) urls.push(["DIRECT_URL", target.directUrl]);

  const extra = (target.protectedHosts ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry) => entry !== "")
    .map(endpointId);

  for (const [name, value] of urls) {
    const id = endpointId(hostOf(name, value));
    const hash = hashEndpoint(id);
    const hit = protectedEndpoints.find((entry) => entry.sha256 === hash);
    if (hit && !(hit.branch === "dev" && target.sgauthEnv === "dev")) {
      refuse(
        `${name} points at the Neon ${hit.branch} branch` +
          (hit.branch === "dev" ? " and SGAUTH_ENV is not dev" : ""),
      );
    }
    if (extra.includes(id)) {
      refuse(`${name} host is listed in SGAUTH_PROTECTED_DB_HOSTS`);
    }
  }
}
