import "dotenv/config";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  ImportConflictError,
  ImportInputError,
} from "../prisma/import/chambers.js";
import { writeOutput } from "../prisma/import/output.js";
import {
  applySlackLinkImport,
  buildSlackLinkReport,
  formatSlackLinkSummary,
  loadSlackLinkSource,
  parseSlackLinkImportArgs,
  planSlackLinkImport,
  readSlackLinkState,
} from "../prisma/import/slack-links.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Imports Chambers' Slack links (#315) from the file Chambers'
// scripts/sgauth/export-slack-links.mjs writes. Standalone ops script, like
// scripts/import-aplio-users.ts: it parses its own env and builds its own
// client, and holding the target's DIRECT_URL is the authorization. Prints
// counts only; the report next to it holds SGAuth ids, never a Slack id or an
// address. See docs/runbooks/slack-link-import.md.

const USAGE =
  "Usage: npm run import:slack-links -- --source <slack-links.json> --team <T...> (--dry-run | --apply)";

async function main() {
  const args = parseSlackLinkImportArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);
  const source = await loadSlackLinkSource(args.source);

  const target = describeTarget(env.DIRECT_URL);
  console.log(`Target: ${target} (SGAUTH_ENV=${env.SGAUTH_ENV})`);
  console.log(`Source: ${source.rows.length} rows, sha256 ${source.sha256}`);

  const now = new Date();
  const out = join(
    ".temp",
    "slack-link-import",
    now.toISOString().replace(/[:.]/g, ""),
  );
  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planSlackLinkImport(
      args.team,
      source.rows,
      await readSlackLinkState(prisma, args.team, source.rows),
    );
    console.log(formatSlackLinkSummary(plan));
    await mkdir(out, { recursive: true });
    const reportPath = join(out, "report.json");
    const meta = { generatedAt: now, target, sourceSha256: source.sha256 };

    if (!args.apply) {
      await writeOutput(
        reportPath,
        buildSlackLinkReport(plan, { ...meta, dryRun: true }),
        false,
      );
      console.log(`Report: ${reportPath}`);
      console.log("Dry run. Re-run with --apply to write these links.");
      return;
    }

    const applied = await applySlackLinkImport(prisma, {
      team: args.team,
      rows: source.rows,
      sourceSha256: source.sha256,
    });
    console.log(`Applied:\n${formatSlackLinkSummary(applied)}`);
    await writeOutput(
      reportPath,
      buildSlackLinkReport(applied, { ...meta, dryRun: false }),
      true,
    );
    console.log(`Report: ${reportPath}`);
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
    // Never print error.message: Prisma errors echo the call's arguments.
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
