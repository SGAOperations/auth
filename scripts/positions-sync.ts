import "dotenv/config";
import pg from "pg";
import { z } from "zod";
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

// Standalone ops script: parses its own env and builds its own client, the same
// exception as prisma/seed.ts. Dry run by default; `--apply` writes. Allowed in
// production, unlike `npm run seed`. See docs/runbooks/positions-sync.md.

const USAGE = "Usage: npm run positions:sync [-- --apply]";

const envSchema = z.object({
  DIRECT_URL: z.string().min(1),
  SGAUTH_ENV: z.enum(["production", "dev", "preview", "local"]),
});

function parseArgs(argv: string[]): { apply: boolean } {
  const unknown = argv.filter((arg) => arg !== "--apply");
  if (unknown.length > 0) {
    throw new UsageError(`Unknown argument: ${unknown.join(" ")}`);
  }
  return { apply: argv.includes("--apply") };
}

class UsageError extends Error {}

/** Host and database only: never the credentials. */
function describeTarget(url: string): string {
  const { host, pathname } = new URL(url);
  return `${host}/${pathname.replace(/^\//, "")}`;
}

async function main() {
  const { apply } = parseArgs(process.argv.slice(2));

  const env = envSchema.safeParse(process.env);
  if (!env.success) {
    throw new UsageError(
      `Invalid environment (DIRECT_URL and SGAUTH_ENV=production|dev|preview|local are required):\n${z.prettifyError(env.error)}`,
    );
  }

  // Validated before connecting: a bad JSON file never touches the database.
  const curated = await loadCuratedPositions();

  console.log(
    `Target: ${describeTarget(env.data.DIRECT_URL)} (SGAUTH_ENV=${env.data.SGAUTH_ENV})`,
  );

  const pool = new pg.Pool({ connectionString: env.data.DIRECT_URL });
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
    console.error(error);
  }
  process.exitCode = 1;
});
