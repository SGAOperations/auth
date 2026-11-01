import { readFile } from "node:fs/promises";
import type { PrismaClient } from "../../src/generated/prisma/index.js";
import { parseAuditEvent } from "../../src/lib/audit-catalog.js";
import {
  isSenatePortalLegacyListed,
  planSenatePortalImport,
  validateSenatePortalExport,
  type SenatePortalPlan,
  type SenatePortalRow,
} from "../../src/lib/import/senateportal.js";
import { UsageError } from "../seed/sync-env.js";
import { parseFlags, readAplioState, stampedDir } from "./aplio.js";
import {
  ImportConflictError,
  ImportInputError,
  isUniqueViolation,
} from "./chambers.js";

// The SenatePortal user import, behind scripts/import-senateportal-users.ts.
// Like aplio.ts it takes its client as an argument and never reads process.env
// (ENGINEERING §2). It sends no email, writes no Account or Verification row,
// and assigns no position. NUID never gets past the export validator. See
// docs/runbooks/senateportal-import.md.

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type SenatePortalImportArgs = {
  source: string;
  apply: boolean;
  out: string;
};

export function parseSenatePortalImportArgs(
  argv: string[],
  now: Date = new Date(),
): SenatePortalImportArgs {
  const { values, bare } = parseFlags(
    argv,
    ["--source", "--out"],
    ["--dry-run", "--apply"],
  );
  const source = values.get("--source");
  if (source === undefined) throw new UsageError("--source is required");
  if (bare.has("--dry-run") === bare.has("--apply")) {
    throw new UsageError("Give exactly one of --dry-run or --apply");
  }
  return {
    source,
    apply: bare.has("--apply"),
    out: values.get("--out") ?? stampedDir("senateportal-import", now),
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type LoadedSenatePortalSource = {
  rows: SenatePortalRow[];
  sha256: string;
  droppedColumns: string[];
};

export async function loadSenatePortalSource(
  path: string,
): Promise<LoadedSenatePortalSource> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new ImportInputError("Cannot read the source file");
  }
  const result = validateSenatePortalExport(bytes);
  if (!result.ok) {
    if (result.unparseable) {
      throw new ImportInputError("source is not valid JSON");
    }
    const lines = result.errors.map(
      (error) => `  - ${error.path}: ${error.message}`,
    );
    throw new ImportInputError(
      `The source file is not a valid SenatePortal export:\n${lines.join("\n")}`,
    );
  }
  return {
    rows: result.rows,
    sha256: result.sha256,
    droppedColumns: result.droppedColumns,
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type SenatePortalApplyInput = {
  rows: SenatePortalRow[];
  sourceSha256: string;
};

/**
 * Writes the plan in one transaction, re-planned from fresh reads, together with
 * the BULK_IMPORT event: if the audit write fails, everything rolls back.
 * Returns the plan that was applied, with the created users' ids filled in.
 */
export async function applySenatePortalImport(
  db: PrismaClient,
  input: SenatePortalApplyInput,
): Promise<SenatePortalPlan> {
  const { rows, sourceSha256 } = input;
  try {
    return await db.$transaction(
      async (tx) => {
        const plan = planSenatePortalImport(
          rows,
          await readAplioState(tx, rows),
        );

        const creating = plan.rows.filter((entry) => entry.create !== null);
        const created =
          creating.length === 0
            ? []
            : await tx.user.createManyAndReturn({
                data: creating.map((entry) => entry.create!),
                select: { id: true, email: true },
              });

        const idByEmail = new Map<string, string>(
          created.map((user) => [user.email.toLowerCase(), user.id]),
        );
        for (const entry of plan.rows) {
          if (entry.outcome === "merge") {
            idByEmail.set(entry.row.email, entry.userId!);
          }
        }
        const applied = plan.rows.map((entry) =>
          entry.outcome === "create" || entry.outcome === "duplicate-in-source"
            ? { ...entry, userId: idByEmail.get(entry.row.email) ?? null }
            : entry,
        );

        const { counts } = plan;
        await tx.auditEvent.create({
          data: parseAuditEvent({
            type: "BULK_IMPORT",
            actorType: "SYSTEM",
            metadata: {
              source: "senateportal",
              sourceSha256,
              created: counts.create,
              merged: counts.merge,
              duplicateInSource: counts.duplicateInSource,
              skipped: counts.skip,
              legacyEmails: counts.legacyEmails,
            },
          }),
        });
        return { ...plan, rows: applied };
      },
      // One transaction of batch statements, as in the Chambers import.
      { timeout: 300_000, maxWait: 15_000 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new ImportConflictError(
        "Another writer created a user with an imported email; re-run.",
      );
    }
    throw error;
  }
}

// ---------------------------------------------------------------------------
// Output
// ---------------------------------------------------------------------------

export type SenatePortalReportMeta = {
  generatedAt: Date;
  dryRun: boolean;
  target: string;
  sourceSha256: string;
  droppedColumns: string[];
};

/** Holds addresses (PII): written to a gitignored directory, then deleted. */
export function buildSenatePortalReport(
  plan: SenatePortalPlan,
  meta: SenatePortalReportMeta,
) {
  return {
    generatedAt: meta.generatedAt.toISOString(),
    dryRun: meta.dryRun,
    target: meta.target,
    sourceSha256: meta.sourceSha256,
    droppedColumns: meta.droppedColumns,
    counts: plan.counts,
    legacyEmails: plan.rows.filter(isSenatePortalLegacyListed).map((entry) => ({
      senatePortalId: entry.row.senatePortalId,
      email: entry.row.email,
      outcome: entry.outcome,
    })),
    rows: plan.rows.map((entry) => ({
      senatePortalId: entry.row.senatePortalId,
      email: entry.row.email,
      outcome: entry.outcome,
      reasons: entry.reasons,
      notes: entry.notes,
    })),
  };
}

/** Every created, merged and duplicate-in-source row: never a skipped one. */
export function buildSenatePortalIdMap(
  plan: SenatePortalPlan,
  meta: { generatedAt: Date; sourceSha256: string },
) {
  return {
    generatedAt: meta.generatedAt.toISOString(),
    sourceSha256: meta.sourceSha256,
    mappings: plan.rows.flatMap((entry) =>
      entry.outcome === "skip" || entry.userId === null
        ? []
        : [
            {
              senatePortalId: entry.row.senatePortalId,
              sgauthId: entry.userId,
              outcome: entry.outcome,
            },
          ],
    ),
  };
}

/** Console summary: SenatePortal ids and counts only, never an address or a name. */
export function formatSenatePortalSummary(
  plan: SenatePortalPlan,
  droppedColumns: string[] = [],
): string {
  const lines: string[] = [];
  if (droppedColumns.length > 0) {
    lines.push(
      `! dropped columns not in the contract: ${droppedColumns.join(", ")} (values never read); re-export without them`,
    );
  }
  for (const entry of plan.rows) {
    if (entry.outcome === "skip") {
      lines.push(
        `! skip ${entry.row.senatePortalId} ${entry.reasons.join("; ")}`,
      );
    }
  }
  const { counts } = plan;
  if (counts.legacyEmails > 0) {
    lines.push(
      `! ${counts.legacyEmails} accounts are outside @northeastern.edu (legacyEmail); see report.json`,
    );
  }
  lines.push(
    `${counts.rows} rows: ${counts.create} create, ${counts.merge} merge, ${counts.duplicateInSource} duplicate in source, ${counts.skip} skip; ${counts.nameDefaulted} names defaulted; no positions assigned`,
  );
  return lines.join("\n");
}
