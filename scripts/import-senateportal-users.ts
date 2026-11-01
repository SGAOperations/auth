import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import { planSenatePortalImport } from "../src/lib/import/senateportal.js";
import { readAplioState } from "../prisma/import/aplio.js";
import {
  ImportConflictError,
  ImportInputError,
} from "../prisma/import/chambers.js";
import { writeOutput } from "../prisma/import/output.js";
import {
  applySenatePortalImport,
  buildSenatePortalIdMap,
  buildSenatePortalReport,
  formatSenatePortalSummary,
  loadSenatePortalSource,
  parseSenatePortalImportArgs,
} from "../prisma/import/senateportal.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Imports SenatePortal users (id, email, first and last name; no passwords, no
// NUID, no positions) from an export file, with the id-mapping file for
// ATTENDANCE-M05. Standalone ops script, like scripts/import-aplio-users.ts: it
// parses its own env and builds its own client. Holding the target's
// DIRECT_URL is the authorization. It sends no email and writes no Account or
// Verification row. See docs/runbooks/senateportal-import.md.

const USAGE =
  "Usage: npm run import:senateportal -- --source <senateportal-export.json> [--out <dir>] (--dry-run | --apply)";

async function main() {
  const args = parseSenatePortalImportArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);

  // Everything is validated before connecting: a bad file never touches the
  // database.
  const source = await loadSenatePortalSource(args.source);

  const target = describeTarget(env.DIRECT_URL);
  console.log(`Target: ${target} (SGAUTH_ENV=${env.SGAUTH_ENV})`);
  console.log(`Source: ${source.rows.length} rows, sha256 ${source.sha256}`);

  const now = new Date();
  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planSenatePortalImport(
      source.rows,
      await readAplioState(prisma, source.rows),
    );
    console.log(formatSenatePortalSummary(plan, source.droppedColumns));

    const meta = {
      generatedAt: now,
      target,
      sourceSha256: source.sha256,
      droppedColumns: source.droppedColumns,
    };
    await mkdir(args.out, { recursive: true });
    const reportPath = join(args.out, "report.json");

    if (!args.apply) {
      await writeOutput(
        reportPath,
        buildSenatePortalReport(plan, { ...meta, dryRun: true }),
        false,
      );
      console.log(`Report: ${reportPath}`);
      console.log("Dry run. Re-run with --apply to write these changes.");
      return;
    }

    const applied = await applySenatePortalImport(prisma, {
      rows: source.rows,
      sourceSha256: source.sha256,
    });
    console.log(`Applied:\n${formatSenatePortalSummary(applied)}`);
    if (JSON.stringify(applied.counts) !== JSON.stringify(plan.counts)) {
      console.log(
        "Note: the database changed after the dry-run read; the applied plan differs from the one shown above.",
      );
    }
    const idMapPath = join(args.out, "id-map.json");
    await writeOutput(
      reportPath,
      buildSenatePortalReport(applied, { ...meta, dryRun: false }),
      true,
    );
    await writeOutput(idMapPath, buildSenatePortalIdMap(applied, meta), true);
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
