import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  CuratedPositionsError,
  SyncConflictError,
  applySync,
  countPlan,
  formatSummary,
  loadCuratedPositions,
  planSync,
  readExistingPositions,
} from "../prisma/seed/positions.js";
import {
  UsageError,
  describeTarget,
  parseArgs,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Standalone ops script: parses its own env and builds its own client, the same
// exception as prisma/seed.ts. Dry run by default; `--apply` writes. Allowed in
// production, unlike `npm run seed`. See docs/runbooks/positions-sync.md.

const USAGE = "Usage: npm run positions:sync [-- --apply]";

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);

  // Validated before connecting: a bad JSON file never touches the database.
  const curated = await loadCuratedPositions();

  console.log(
    `Target: ${describeTarget(env.DIRECT_URL)} (SGAUTH_ENV=${env.SGAUTH_ENV})`,
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planSync(curated, await readExistingPositions(prisma));
    console.log(formatSummary(plan));

    if (!apply) {
      console.log("Dry run. Re-run with --apply to write these changes.");
      return;
    }

    const applied = await applySync(prisma, plan);
    const { create, update, unchanged, skipped } = applied.counts;
    console.log(
      `Applied: ${create} create, ${update} update, ${unchanged} unchanged, ${skipped} skipped`,
    );
    if (
      countPlan(plan).create !== create ||
      countPlan(plan).update !== update
    ) {
      console.log(
        "Note: the database changed after the dry-run read; the applied plan differs from the one shown above.",
      );
    }
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (
    error instanceof CuratedPositionsError ||
    error instanceof SyncConflictError
  ) {
    console.error(error.message);
  } else {
    // Never console.error the raw error: some carry connection strings or the
    // offending input, and DIRECT_URL holds the migration role's password.
    console.error(
      error instanceof Error
        ? `${error.name}: ${error.message}`
        : "Unexpected error",
    );
  }
  process.exitCode = 1;
});
