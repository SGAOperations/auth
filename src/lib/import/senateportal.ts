import { createHash } from "node:crypto";
import { z } from "zod";
import {
  aplioEmailSchema,
  planAplioRow,
  type AplioCreate,
  type AplioState,
} from "./aplio";
import { isNortheasternEmail } from "./email-domain";

// The SenatePortal user import's rules: the export schema and the whole-file
// planner. SenatePortal is the new name for Attendance Manager. Pure on
// purpose, like aplio.ts: no filesystem, no env, no database, no `server-only`,
// and nothing that sends mail or writes a Verification row. The per-row
// decision is Aplio's, so a SenatePortal user looks exactly like an Aplio one:
// password-less, and set up through the set-password flow (AUTH-T22) on first
// sign-in. The import grants no positions: SenatePortal's role column is not a
// record of who holds an office. See docs/runbooks/senateportal-import.md.

const datetime = z.iso.datetime({ offset: true });

const nameSchema = z.string().max(255);

// Not strict: an export that still carries `nuid` (or any other column) is
// accepted, and the column is dropped here, before any other code sees the row.
// Only the dropped columns' names are reported, never their values.
const senatePortalRowSchema = z.object({
  id: z.string().min(1).max(255),
  email: aplioEmailSchema,
  firstName: nameSchema,
  lastName: nameSchema,
  deletedAt: datetime.nullable(),
});

const KNOWN_COLUMNS: ReadonlySet<string> = new Set(
  Object.keys(senatePortalRowSchema.shape),
);

export const senatePortalExportSchema = z.array(senatePortalRowSchema);

export type SenatePortalRow = {
  senatePortalId: string;
  /** Trimmed and lower-cased. */
  email: string;
  /** First and last name joined; null when both are blank. */
  name: string | null;
  deletedAt: string | null;
};

export type SenatePortalExportIssue = { path: string; message: string };

export type SenatePortalExportValidation =
  | {
      ok: true;
      sha256: string;
      rows: SenatePortalRow[];
      /** Names of the columns that were dropped, sorted. Never their values. */
      droppedColumns: string[];
    }
  | {
      ok: false;
      /** True when the bytes are not decodable, parseable JSON. */
      unparseable: boolean;
      sha256: string;
      errors: SenatePortalExportIssue[];
    };

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "$" : out;
}

/** The only function that reads export fields. */
export function toSenatePortalRow(
  parsed: z.output<typeof senatePortalRowSchema>,
): SenatePortalRow {
  const name = `${parsed.firstName.trim()} ${parsed.lastName.trim()}`.trim();
  return {
    senatePortalId: parsed.id,
    email: parsed.email,
    name: name === "" ? null : name,
    deletedAt: parsed.deletedAt,
  };
}

function droppedColumnsOf(json: unknown[]): string[] {
  const dropped = new Set<string>();
  for (const raw of json) {
    if (typeof raw !== "object" || raw === null) continue;
    for (const key of Object.keys(raw)) {
      if (!KNOWN_COLUMNS.has(key)) dropped.add(key);
    }
  }
  return [...dropped].sort();
}

/**
 * Validates the whole export. Errors name the path and the rule, never the
 * value: ids and addresses are PII. A duplicate id is an error; a duplicate
 * address is not (the planner maps every such row to one user).
 */
export function validateSenatePortalExport(
  raw: Uint8Array | string,
): SenatePortalExportValidation {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const sha256 = createHash("sha256").update(bytes).digest("hex");

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return {
      ok: false,
      unparseable: true,
      sha256,
      errors: [{ path: "$", message: "not valid JSON" }],
    };
  }

  const parsed = senatePortalExportSchema.safeParse(json);
  if (!parsed.success) {
    return {
      ok: false,
      unparseable: false,
      sha256,
      errors: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
      })),
    };
  }

  const rows = parsed.data.map(toSenatePortalRow);
  const errors: SenatePortalExportIssue[] = [];
  const firstIndex = new Map<string, number>();
  rows.forEach((row, index) => {
    const first = firstIndex.get(row.senatePortalId);
    if (first === undefined) firstIndex.set(row.senatePortalId, index);
    else {
      errors.push({
        path: `[${index}].id`,
        message: `duplicate id (same as [${first}])`,
      });
    }
  });
  if (errors.length > 0)
    return { ok: false, unparseable: false, sha256, errors };
  return {
    ok: true,
    sha256,
    rows,
    // The schema accepted an array, so `json` is one.
    droppedColumns: droppedColumnsOf(json as unknown[]),
  };
}

// ---------------------------------------------------------------------------
// The import plan
// ---------------------------------------------------------------------------

export type SenatePortalOutcome =
  | "create"
  | "merge"
  | "duplicate-in-source"
  | "skip";

export type PlannedSenatePortalRow = {
  row: SenatePortalRow;
  outcome: SenatePortalOutcome;
  /** Why a row was skipped. */
  reasons: string[];
  notes: string[];
  /** The SGAuth user it maps to; null for a skip, and for a create until apply. */
  userId: string | null;
  /** Set on a create only. */
  create: AplioCreate | null;
};

export type SenatePortalCounts = {
  rows: number;
  create: number;
  merge: number;
  duplicateInSource: number;
  skip: number;
  legacyEmails: number;
  nameDefaulted: number;
};

export type SenatePortalPlan = {
  rows: PlannedSenatePortalRow[];
  counts: SenatePortalCounts;
};

const SOFT_DELETED = "soft-deleted in SenatePortal";

export function planSenatePortalImport(
  rows: SenatePortalRow[],
  state: AplioState,
): SenatePortalPlan {
  // The first live row for an address decides; later ones follow it.
  const decided = new Map<string, PlannedSenatePortalRow>();

  const planned = rows.map((row): PlannedSenatePortalRow => {
    const base = { row, reasons: [], notes: [], userId: null, create: null };
    if (row.deletedAt !== null) {
      return { ...base, outcome: "skip", reasons: [SOFT_DELETED] };
    }
    const first = decided.get(row.email);
    if (first !== undefined) {
      if (first.outcome === "skip") {
        return { ...base, outcome: "skip", reasons: first.reasons };
      }
      return {
        ...base,
        outcome: "duplicate-in-source",
        notes: ["same address as an earlier row"],
        userId: first.userId,
      };
    }

    const decision = planAplioRow(row, state.users.get(row.email));
    let entry: PlannedSenatePortalRow;
    if (decision.outcome === "create") {
      entry = {
        ...base,
        outcome: "create",
        notes: decision.notes,
        create: decision.create,
      };
    } else if (decision.outcome === "merge") {
      entry = {
        ...base,
        outcome: "merge",
        notes: decision.notes,
        userId: decision.userId,
      };
    } else {
      entry = {
        ...base,
        outcome: "skip",
        reasons: [decision.reason],
        notes: decision.notes,
      };
    }
    decided.set(row.email, entry);
    return entry;
  });

  return { rows: planned, counts: countPlanned(planned) };
}

function countPlanned(planned: PlannedSenatePortalRow[]): SenatePortalCounts {
  const counts: SenatePortalCounts = {
    rows: planned.length,
    create: 0,
    merge: 0,
    duplicateInSource: 0,
    skip: 0,
    legacyEmails: 0,
    nameDefaulted: 0,
  };
  for (const entry of planned) {
    if (entry.outcome === "duplicate-in-source") counts.duplicateInSource += 1;
    else counts[entry.outcome] += 1;
    if (entry.create !== null && entry.notes.includes("name defaulted")) {
      counts.nameDefaulted += 1;
    }
    if (isSenatePortalLegacyListed(entry)) counts.legacyEmails += 1;
  }
  return counts;
}

/** A created or merged row at an address outside @northeastern.edu. */
export function isSenatePortalLegacyListed(
  entry: PlannedSenatePortalRow,
): boolean {
  return (
    (entry.outcome === "create" || entry.outcome === "merge") &&
    !isNortheasternEmail(entry.row.email)
  );
}
