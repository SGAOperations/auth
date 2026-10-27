import type { SgauthEnv } from "../../src/lib/env-schema";

// Pure on purpose: prisma/seed.ts runs it before any database client exists,
// so a refused run never opens a connection.

export class SeedRefusedError extends Error {}

export function assertSeedAllowed(sgauthEnv: SgauthEnv): void {
  if (sgauthEnv === "production") {
    throw new SeedRefusedError(
      "Refusing to seed: SGAUTH_ENV=production. The seed only runs against local, dev or preview databases. To load positions in production, use npm run positions:sync (docs/runbooks/positions-sync.md).",
    );
  }
}
