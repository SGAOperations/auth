import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/index.js";
import { parseAuditEvent } from "../../src/lib/audit-catalog.js";
import {
  isLegacyListed,
  planAplioImport,
  validateAplioExport,
  type AplioPlan,
  type AplioRow,
  type AplioState,
} from "../../src/lib/import/aplio.js";
import {
  BLOCKING_CATEGORIES,
  type DualWriteUser,
  type ReconcileResult,
} from "../../src/lib/import/aplio-reconcile.js";
import { UsageError } from "../seed/sync-env.js";
import {
  ImportConflictError,
  ImportInputError,
  isUniqueViolation,
} from "./chambers.js";

// The Aplio user import and reconcile, behind scripts/import-aplio-users.ts and
// scripts/reconcile-aplio.ts. Like chambers.ts it takes its client as an
// argument and never reads process.env (ENGINEERING §2). It sends no email and
// writes no Account or Verification row: every created user is password-less
// and sets a password through the set-password flow (AUTH-T22) when they sign
// in. See docs/runbooks/aplio-import.md.

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** The default output directory: `.temp/<prefix>/<UTC stamp>`. */
export function stampedDir(prefix: string, now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return `.temp/${prefix}/${stamp}`;
}

/** Splits argv into value flags and bare flags, rejecting anything else. */
export function parseFlags(
  argv: string[],
  valueFlags: readonly string[],
  bareFlags: readonly string[],
): { values: Map<string, string>; bare: Set<string> } {
  const values = new Map<string, string>();
  const bare = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (bareFlags.includes(arg)) {
      if (bare.has(arg))
        throw new UsageError(`${arg} was given more than once`);
      bare.add(arg);
    } else if (valueFlags.includes(arg)) {
      if (values.has(arg)) {
        throw new UsageError(`${arg} was given more than once`);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      values.set(arg, value);
      i += 1;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  return { values, bare };
}

export type AplioImportArgs = { source: string; apply: boolean; out: string };

export function parseAplioImportArgs(
  argv: string[],
  now: Date = new Date(),
): AplioImportArgs {
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
    out: values.get("--out") ?? stampedDir("aplio-import", now),
  };
}

export type AplioReconcileArgs = {
  source: string;
  cutoverAt: Date;
  out: string;
};

const cutoverSchema = z.iso.datetime({ offset: true });

export function parseAplioReconcileArgs(
  argv: string[],
  now: Date = new Date(),
): AplioReconcileArgs {
  const { values } = parseFlags(
    argv,
    ["--source", "--cutover-at", "--out"],
    [],
  );
  const source = values.get("--source");
  if (source === undefined) throw new UsageError("--source is required");
  const cutover = values.get("--cutover-at");
  if (cutover === undefined) throw new UsageError("--cutover-at is required");
  if (!cutoverSchema.safeParse(cutover).success) {
    throw new UsageError(
      "--cutover-at must be an ISO 8601 time with an offset, such as 2026-12-01T05:00:00-05:00",
    );
  }
  return {
    source,
    cutoverAt: new Date(cutover),
    out: values.get("--out") ?? stampedDir("aplio-reconcile", now),
  };
}

// ---------------------------------------------------------------------------
// Loader
// ---------------------------------------------------------------------------

export type LoadedAplioSource = { rows: AplioRow[]; sha256: string };

export async function loadAplioSource(
  path: string,
): Promise<LoadedAplioSource> {
  let bytes: Buffer;
  try {
    bytes = await readFile(path);
  } catch {
    throw new ImportInputError("Cannot read the source file");
  }
  const result = validateAplioExport(bytes);
  if (!result.ok) {
    if (result.unparseable) {
      throw new ImportInputError("source is not valid JSON");
    }
    const lines = result.errors.map(
      (error) => `  - ${error.path}: ${error.message}`,
    );
    throw new ImportInputError(
      `The source file is not a valid Aplio export:\n${lines.join("\n")}`,
    );
  }
  return { rows: result.rows, sha256: result.sha256 };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

type UserReader = Pick<Prisma.TransactionClient, "user">;

/** The fields the state read needs: the SenatePortal import shares it. */
type StateRow = Pick<AplioRow, "email" | "deletedAt">;

function liveEmails(rows: StateRow[]): string[] {
  return [
    ...new Set(
      rows.filter((row) => row.deletedAt === null).map((row) => row.email),
    ),
  ];
}

/** Existing users at the live rows' addresses, by lower-cased email. */
export async function readAplioState(
  db: UserReader,
  rows: StateRow[],
): Promise<AplioState> {
  const users = await db.user.findMany({
    where: { email: { in: liveEmails(rows) } },
    select: { id: true, email: true, status: true, emailVerified: true },
  });
  return {
    users: new Map(
      users.map((user) => [
        user.email.toLowerCase(),
        {
          id: user.id,
          status: user.status,
          emailVerified: user.emailVerified,
        },
      ]),
    ),
  };
}

/**
 * Read-only state for reconcile: the users at the live rows' addresses, and
 * every user the dual-write endpoint created.
 */
export async function readReconcileState(
  db: Pick<Prisma.TransactionClient, "user" | "auditEvent">,
  rows: AplioRow[],
): Promise<{ state: AplioState; dualWriteUsers: DualWriteUser[] }> {
  const state = await readAplioState(db, rows);
  const events = await db.auditEvent.findMany({
    where: {
      type: "USER_CREATED",
      metadata: { path: ["source"], equals: "aplio_dual_write" },
    },
    select: { targetId: true },
  });
  const ids = events.flatMap((event) =>
    event.targetId === null ? [] : [event.targetId],
  );
  const users = await db.user.findMany({
    where: { id: { in: ids } },
    select: { id: true, email: true },
  });
  return {
    state,
    dualWriteUsers: users.map((user) => ({
      userId: user.id,
      email: user.email.toLowerCase(),
    })),
  };
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type AplioApplyInput = { rows: AplioRow[]; sourceSha256: string };

/**
 * Writes the plan in one transaction, re-planned from fresh reads, together with
 * the BULK_IMPORT event: if the audit write fails, everything rolls back.
 * Returns the plan that was applied, with the created users' ids filled in. A
 * dual write landing mid-apply surfaces as an ImportConflictError; a re-run
 * converges.
 */
export async function applyAplioImport(
  db: PrismaClient,
  input: AplioApplyInput,
): Promise<AplioPlan> {
  const { rows, sourceSha256 } = input;
  try {
    return await db.$transaction(
      async (tx) => {
        const plan = planAplioImport(rows, await readAplioState(tx, rows));

        const creating = plan.rows.filter((entry) => entry.create !== null);
        const created =
          creating.length === 0
            ? []
            : await tx.user.createManyAndReturn({
                data: creating.map((entry) => entry.create!),
                select: { id: true, email: true },
              });
        const createdIds = new Map(
          created.map((user) => [user.email.toLowerCase(), user.id]),
        );

        const idByEmail = new Map<string, string>(createdIds);
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
              source: "aplio",
              sourceSha256,
              created: counts.create,
              merged: counts.merge,
              duplicateInSource: counts.duplicateInSource,
              skipped: counts.skip,
              legacyEmails: counts.legacyEmails,
              aplioAdmins: counts.aplioAdmins,
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

export type AplioReportMeta = {
  generatedAt: Date;
  dryRun: boolean;
  target: string;
  sourceSha256: string;
};

/** Holds addresses (PII): written to a gitignored directory, then deleted. */
export function buildAplioReport(plan: AplioPlan, meta: AplioReportMeta) {
  return {
    generatedAt: meta.generatedAt.toISOString(),
    dryRun: meta.dryRun,
    target: meta.target,
    sourceSha256: meta.sourceSha256,
    counts: plan.counts,
    legacyEmails: plan.rows.filter(isLegacyListed).map((entry) => ({
      aplioId: entry.row.aplioId,
      email: entry.row.email,
      outcome: entry.outcome,
    })),
    rows: plan.rows.map((entry) => ({
      aplioId: entry.row.aplioId,
      email: entry.row.email,
      outcome: entry.outcome,
      reasons: entry.reasons,
      notes: entry.notes,
    })),
  };
}

/** Every created, merged and duplicate-in-source row: never a skipped one. */
export function buildAplioIdMap(
  plan: AplioPlan,
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
              aplioId: entry.row.aplioId,
              sgauthId: entry.userId,
              outcome: entry.outcome,
            },
          ],
    ),
  };
}

/** Console summary: Aplio ids and counts only, never an address or a name. */
export function formatAplioSummary(plan: AplioPlan): string {
  const lines: string[] = [];
  for (const entry of plan.rows) {
    if (entry.outcome === "skip") {
      lines.push(`! skip ${entry.row.aplioId} ${entry.reasons.join("; ")}`);
    }
  }
  const { counts } = plan;
  if (counts.legacyEmails > 0) {
    lines.push(
      `! ${counts.legacyEmails} accounts are outside @northeastern.edu (legacyEmail); see report.json`,
    );
  }
  lines.push(
    `${counts.rows} rows: ${counts.create} create, ${counts.merge} merge, ${counts.duplicateInSource} duplicate in source, ${counts.skip} skip; ${counts.nameDefaulted} names defaulted; ${counts.aplioAdmins} Aplio admins (not granted)`,
  );
  return lines.join("\n");
}

const FIXES: Record<(typeof BLOCKING_CATEGORIES)[number], string> = {
  "missing-in-sgauth":
    "re-run import:aplio --apply with a fresh export, then send the new id-map.json for backfill",
  "needs-backfill":
    "Aplio re-runs its APLIO-P03 backfill from the latest id-map.json",
  mismatch: "stop and resolve by hand; never switch with a mismatch",
  blocked:
    "by hand: the address's owner verifies the SGAuth account, or an admin tombstones a squatter",
};

function timeLeft(now: Date, cutoverAt: Date): string {
  const ms = cutoverAt.getTime() - now.getTime();
  if (ms <= 0) return "the cutover has passed";
  const hours = Math.floor(ms / 3_600_000);
  const minutes = Math.floor((ms % 3_600_000) / 60_000);
  return `${hours}h ${minutes}m until the cutover`;
}

/** Console output: counts, the fix per non-zero category, then the verdict. */
export function formatReconcileSummary(
  result: ReconcileResult,
  now: Date,
  cutoverAt: Date,
): string {
  const lines = [
    `Cutover: ${cutoverAt.toISOString()} (${timeLeft(now, cutoverAt)})`,
  ];
  for (const [category, n] of Object.entries(result.counts)) {
    lines.push(`${category}: ${n}`);
  }
  lines.push(`sgauth-only (review, never blocks): ${result.sgauthOnly.length}`);
  for (const category of BLOCKING_CATEGORIES) {
    if (result.counts[category] > 0) {
      lines.push(`! ${category}: ${FIXES[category]}`);
    }
  }
  lines.push(
    result.ready
      ? `READY: switch reads at ${cutoverAt.toISOString()}`
      : `NOT READY: ${result.reasons.join(", ")}`,
  );
  return lines.join("\n");
}

/** Holds addresses (PII). */
export function buildReconcileReport(
  result: ReconcileResult,
  meta: {
    generatedAt: Date;
    target: string;
    sourceSha256: string;
    cutoverAt: Date;
  },
) {
  return {
    generatedAt: meta.generatedAt.toISOString(),
    target: meta.target,
    sourceSha256: meta.sourceSha256,
    cutoverAt: meta.cutoverAt.toISOString(),
    ready: result.ready,
    reasons: result.reasons,
    counts: result.counts,
    entries: result.entries,
    sgauthOnly: result.sgauthOnly,
  };
}
