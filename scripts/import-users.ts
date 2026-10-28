import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  ImportConflictError,
  ImportInputError,
  applyImport,
  buildIdMap,
  buildReport,
  checkApproval,
  formatImportSummary,
  loadEmailReplacements,
  loadMapping,
  loadSource,
  parseImportArgs,
  planHasErrors,
  planImport,
  readImportState,
  readPrimaryAdminEmail,
  toImportRow,
  type ImportPlan,
  type LoadedReplacements,
} from "../prisma/import/chambers.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Imports Chambers users, bcrypt hashes and positions from a validated export
// (docs/runbooks/chambers-export.md). Standalone ops script, like
// scripts/positions-sync.ts: it parses its own env and builds its own client.
// Holding the target's DIRECT_URL is the authorization. See
// docs/runbooks/chambers-import.md.

const USAGE =
  "Usage: npm run import:users -- --source <export.json> --mapping <mapping.json> [--email-replacements <file>] [--out <dir>] (--dry-run | --apply)";

const NO_REPLACEMENTS: LoadedReplacements = {
  replacements: new Map(),
  sha256: "",
  count: 0,
};

/** Never overwrites: an existing file means the data was already written. */
async function writeOutput(path: string, value: unknown, committed: boolean) {
  try {
    await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, {
      flag: "wx",
    });
  } catch (error) {
    if (
      typeof error === "object" &&
      error !== null &&
      "code" in error &&
      error.code === "EEXIST"
    ) {
      throw new ImportInputError(
        `Output file ${path} already exists.${committed ? " The import was committed; re-run with a fresh --out." : " Use a fresh --out."}`,
      );
    }
    throw error;
  }
}

function formatCounts(plan: ImportPlan): string {
  const { create, merge, unchanged, skip } = plan.counts;
  return `${create} create, ${merge} merge, ${unchanged} unchanged, ${skip} skip`;
}

async function main() {
  const args = parseImportArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);

  // Everything is validated before connecting: a bad file never touches the
  // database.
  const source = await loadSource(args.source);
  const mapping = await loadMapping(args.mapping);
  const replacementsFile =
    args.emailReplacements === null
      ? null
      : await loadEmailReplacements(args.emailReplacements);
  const replacements = (replacementsFile ?? NO_REPLACEMENTS).replacements;

  const target = describeTarget(env.DIRECT_URL);
  console.log(`Target: ${target} (SGAUTH_ENV=${env.SGAUTH_ENV})`);
  console.log(
    `Source: ${source.data.users.length} rows from ${source.data.source} exported ${source.data.exported_at}, sha256 ${source.sha256}`,
  );
  for (const warning of source.warnings) console.log(`~ ${warning}`);
  console.log(
    `Mapping: ${mapping.roles.size} roles, approved by ${mapping.approvedBy ?? "nobody"} on ${mapping.approvedAt ?? "never"}`,
  );
  console.log(
    replacementsFile === null
      ? "Replacements: none"
      : `Replacements: ${replacementsFile.count} entries, sha256 ${replacementsFile.sha256}`,
  );

  const now = new Date();
  const rows = source.data.users.map((user) =>
    toImportRow(user, replacements, now),
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planImport(
      rows,
      source.data.source,
      mapping,
      replacements,
      await readImportState(prisma, rows, mapping),
    );

    let approvalNote: string | null;
    try {
      approvalNote = checkApproval(
        mapping,
        await readPrimaryAdminEmail(prisma),
        env.SGAUTH_ENV,
      );
    } catch (error) {
      if (args.apply || !(error instanceof ImportInputError)) throw error;
      approvalNote = `${error.message} (--apply would refuse)`;
    }
    if (approvalNote !== null) console.log(`~ ${approvalNote}`);

    console.log(formatImportSummary(plan));
    // A dry run prints the summary first, so it can be used to build the mapping.
    if (planHasErrors(plan)) {
      process.exitCode = 1;
      return;
    }

    const meta = {
      generatedAt: now,
      target,
      exportedAt: source.data.exported_at,
      sourceSha256: source.sha256,
      mappingSha256: mapping.sha256,
      replacementsSha256: replacementsFile?.sha256 ?? null,
    };
    await mkdir(args.out, { recursive: true });

    if (!args.apply) {
      const reportPath = join(args.out, "report.json");
      await writeOutput(
        reportPath,
        buildReport(plan, { ...meta, dryRun: true }),
        false,
      );
      console.log(`Report: ${reportPath}`);
      console.log("Dry run. Re-run with --apply to write these changes.");
      return;
    }

    const applied = await applyImport(prisma, {
      rows,
      exportSource: source.data.source,
      mapping,
      replacements,
      checksums: {
        source: source.sha256,
        replacements: replacementsFile?.sha256 ?? null,
      },
      now,
    });
    console.log(`Applied: ${formatCounts(applied)}`);
    if (formatCounts(applied) !== formatCounts(plan)) {
      console.log(
        "Note: the database changed after the dry-run read; the applied plan differs from the one shown above.",
      );
    }
    const reportPath = join(args.out, "report.json");
    const idMapPath = join(args.out, "id-map.json");
    await writeOutput(
      reportPath,
      buildReport(applied, { ...meta, dryRun: false }),
      true,
    );
    await writeOutput(idMapPath, buildIdMap(applied, meta), true);
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
    // arguments, and those include the bcrypt hashes.
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
