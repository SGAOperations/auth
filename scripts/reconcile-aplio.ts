import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { reconcileAplio } from "../src/lib/import/aplio-reconcile.js";
import {
  buildReconcileReport,
  formatReconcileSummary,
  loadAplioSource,
  parseAplioReconcileArgs,
  readReconcileState,
} from "../prisma/import/aplio.js";
import { ImportInputError } from "../prisma/import/chambers.js";
import { writeOutput } from "../prisma/import/output.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Read-only check run before Aplio's reads switch to SGAuth: it compares a
// fresh Aplio export (with sgauthUserId) against SGAuth and prints READY only
// when nothing is missing, unmapped, mismatched or blocked and the cutover is
// still ahead. It makes no writes and writes no audit row. Same env and error
// handling as scripts/import-aplio-users.ts. See docs/runbooks/aplio-import.md.

const USAGE =
  "Usage: npm run reconcile:aplio -- --source <aplio-export.json> --cutover-at <ISO-8601 with offset> [--out <dir>]";

async function main() {
  const args = parseAplioReconcileArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);
  const source = await loadAplioSource(args.source);

  const target = describeTarget(env.DIRECT_URL);
  console.log(`Target: ${target} (SGAUTH_ENV=${env.SGAUTH_ENV})`);
  console.log(`Source: ${source.rows.length} rows, sha256 ${source.sha256}`);

  const now = new Date();
  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const { state, dualWriteUsers } = await readReconcileState(
      prisma,
      source.rows,
    );
    const result = reconcileAplio(
      source.rows,
      state,
      dualWriteUsers,
      now,
      args.cutoverAt,
    );
    console.log(formatReconcileSummary(result, now, args.cutoverAt));

    await mkdir(args.out, { recursive: true });
    const reportPath = join(args.out, "reconcile.json");
    await writeOutput(
      reportPath,
      buildReconcileReport(result, {
        generatedAt: now,
        target,
        sourceSha256: source.sha256,
        cutoverAt: args.cutoverAt,
      }),
      false,
    );
    console.log(
      `Report: ${reportPath} (holds addresses; delete it afterwards)`,
    );
    if (!result.ready) process.exitCode = 1;
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (error instanceof ImportInputError) {
    console.error(error.message);
  } else {
    // Never print error.message: Prisma validation errors echo the call's
    // arguments, and those include addresses.
    const code =
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      typeof error.code === "string"
        ? ` (${error.code})`
        : "";
    console.error(
      error instanceof Error ? `${error.name}${code}` : "Unexpected error",
    );
  }
  process.exitCode = 1;
});
