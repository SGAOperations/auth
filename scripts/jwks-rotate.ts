import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  JwksRotationError,
  activateStagedKey,
  formatKeyStatus,
  planActivate,
  planRetire,
  planStage,
  readCiphers,
  readKeys,
  retireKey,
  stageKey,
} from "../prisma/seed/jwks-rotation.js";
import { UsageError, describeTarget } from "../prisma/seed/sync-env.js";
import { parseRotateArgs, parseRotateEnv } from "./rotation/jwks-cli.js";
import { jwksUrlFor, kidsOf } from "./rotation/supabase-tpa.js";

// Standalone ops script: parses its own env and builds its own client, the same
// exception as scripts/positions-sync.ts. Dry run by default; `--apply` writes.
// Allowed in production. See docs/runbooks/rotate-secrets.md.

const USAGE =
  "Usage: npm run jwks:rotate [-- status | stage | activate --issuer <https-origin> | retire --kid <id>] [--apply]";

async function fetchPublishedKids(issuer: string): Promise<Set<string>> {
  const response = await fetch(jwksUrlFor(issuer));
  if (!response.ok) {
    throw new JwksRotationError(
      `${jwksUrlFor(issuer)} answered ${response.status}; cannot confirm the staged key is public.`,
    );
  }
  return new Set(kidsOf(await response.json()));
}

async function main() {
  const args = parseRotateArgs(process.argv.slice(2));
  const env = parseRotateEnv(process.env);

  console.log(
    `Target: ${describeTarget(env.directUrl)} (SGAUTH_ENV=${env.sgauthEnv})`,
  );

  const pool = new pg.Pool({ connectionString: env.directUrl });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const now = new Date();
    const keys = await readKeys(prisma, now);
    const ciphers = await readCiphers(prisma, env.secret);
    console.log(formatKeyStatus(keys, ciphers));
    if (args.command === "status") return;

    // A secret that cannot open the signing key is not the one the server uses:
    // a key staged under it would be unreadable to the server.
    const signer = keys.find((key) => key.state === "active");
    if (signer && !ciphers.get(signer.row.id)?.decrypts) {
      throw new JwksRotationError(
        "The secret in this environment does not decrypt the signing key, so it is not the one the server uses. Check BETTER_AUTH_SECRET and BETTER_AUTH_SECRETS. Nothing was changed.",
      );
    }

    if (args.command === "stage") {
      planStage(keys);
      if (!args.apply) {
        console.log(
          "Dry run. Would create a staged key: published in the JWKS, not signing. Re-run with --apply.",
        );
        return;
      }
      const id = await stageKey(prisma, env.secret, now);
      console.log(
        `Staged key ${id}. Push the combined JWKS to every Supabase project (npm run supabase:push-jwks) before activating.`,
      );
      return;
    }

    if (args.command === "activate") {
      const issuer = args.issuer as string;
      const published = await fetchPublishedKids(issuer);
      const plan = planActivate(keys, published);
      if (!args.apply) {
        console.log(
          `Dry run. Would switch signing to ${plan.stagedId} and expire ${plan.activeId} (published for 7 more days). Re-run with --apply.`,
        );
        return;
      }
      const applied = await activateStagedKey(prisma, now, published);
      console.log(
        `Activated ${applied.stagedId}. ${applied.activeId} is expired and stays published for 7 days. Retire it on or after ${new Date(now.getTime() + 7 * 86_400_000).toISOString().slice(0, 10)}.`,
      );
      return;
    }

    const kid = args.kid as string;
    const plan = planRetire(keys, kid);
    if (!args.apply) {
      console.log(
        `Dry run. Would delete key ${plan.retireId}. Re-run with --apply.`,
      );
      return;
    }
    await retireKey(prisma, kid, now);
    console.log(
      `Deleted key ${kid}. Run npm run supabase:push-jwks again so inline integrations drop it.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (error instanceof JwksRotationError) {
    console.error(error.message);
  } else {
    // Never console.error the raw error: some carry connection strings, and
    // DIRECT_URL holds the migration role's password.
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "Unexpected error",
    );
  }
  process.exitCode = 1;
});
