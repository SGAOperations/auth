import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { planAplioImport } from "../src/lib/import/aplio.js";
import {
  applyAplioImport,
  buildAplioIdMap,
  buildAplioReport,
  formatAplioSummary,
  loadAplioSource,
  parseAplioImportArgs,
  readAplioState,
} from "../prisma/import/aplio.js";
import {
  ImportConflictError,
  ImportInputError,
} from "../prisma/import/chambers.js";
import { writeOutput } from "../prisma/import/output.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Imports Aplio users (id, email, name; no passwords) from an export file, with
// the id-mapping file for APLIO-P03. Standalone ops script, like
// scripts/import-users.ts: it parses its own env and builds its own client.
// Holding the target's DIRECT_URL is the authorization. It sends no email and
// writes no Account or Verification row; imported users set a password through
// the set-password flow on first sign-in. See docs/runbooks/aplio-import.md.

const USAGE =
  "Usage: npm run import:aplio -- --source <aplio-export.json> [--out <dir>] (--dry-run | --apply)";

async function main() {
  const args = parseAplioImportArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);

  // Everything is validated before connecting: a bad file never touches the
  // database.
  const source = await loadAplioSource(args.source);

  const target = describeTarget(env.DIRECT_URL);
  console.log(`Target: ${target} (SGAUTH_ENV=${env.SGAUTH_ENV})`);
  console.log(`Source: ${source.rows.length} rows, sha256 ${source.sha256}`);

  const now = new Date();
  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planAplioImport(
      source.rows,
      await readAplioState(prisma, source.rows),
    );
    console.log(formatAplioSummary(plan));

    const meta = {
      generatedAt: now,
      target,
      sourceSha256: source.sha256,
    };
    await mkdir(args.out, { recursive: true });
    const reportPath = join(args.out, "report.json");

    if (!args.apply) {
      await writeOutput(
        reportPath,
        buildAplioReport(plan, { ...meta, dryRun: true }),
        false,
      );
      console.log(`Report: ${reportPath}`);
      console.log("Dry run. Re-run with --apply to write these changes.");
      return;
    }

    const applied = await applyAplioImport(prisma, {
      rows: source.rows,
      sourceSha256: source.sha256,
    });
    console.log(`Applied:\n${formatAplioSummary(applied)}`);
    if (JSON.stringify(applied.counts) !== JSON.stringify(plan.counts)) {
      console.log(
        "Note: the database changed after the dry-run read; the applied plan differs from the one shown above.",
      );
    }
    const idMapPath = join(args.out, "id-map.json");
    await writeOutput(
      reportPath,
      buildAplioReport(applied, { ...meta, dryRun: false }),
      true,
    );
    await writeOutput(idMapPath, buildAplioIdMap(applied, meta), true);
    console.log(`Report: ${reportPath}`);
    console.log(`Id map: ${idMapPath}`);
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (
    error instanceof ImportInputError ||
    error instanceof ImportConflictError
  ) {
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
