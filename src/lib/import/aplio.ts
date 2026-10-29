import { createHash } from "node:crypto";
import { z } from "zod";
import { isNortheasternEmail } from "./email-domain";

// The Aplio user import's rules: the export schema, the per-row decision shared
// with the dual-write endpoint, and the whole-file planner. Pure on purpose: no
// filesystem, no env, no database, no `server-only`, and nothing that sends
// mail or writes a Verification row. An Aplio user is created password-less,
// and sets a password through the set-password flow (AUTH-T22) when they sign
// in. See docs/runbooks/aplio-import.md.

const datetime = z.iso.datetime({ offset: true });

/** Aplio's own id for the user, as the export and the endpoint both carry it. */
export const aplioIdSchema = z.string().min(1).max(255);

export const aplioEmailSchema = z.string().trim().toLowerCase().pipe(z.email());

export const aplioNameSchema = z.string().max(255).nullable();

const aplioRowSchema = z.strictObject({
  id: aplioIdSchema,
  email: aplioEmailSchema,
  name: aplioNameSchema,
  isAdmin: z.boolean(),
  deletedAt: datetime.nullable(),
  // The column APLIO-P03 adds. Only reconcile reads it; the import ignores it.
  sgauthUserId: z.uuid().nullable().optional(),
});

export const aplioExportSchema = z.array(aplioRowSchema);

export type AplioRow = {
  aplioId: string;
  /** Trimmed and lower-cased. */
  email: string;
  name: string | null;
  isAdmin: boolean;
  deletedAt: string | null;
  sgauthUserId: string | null;
};

export type AplioExportIssue = { path: string; message: string };

export type AplioExportValidation =
  | { ok: true; sha256: string; rows: AplioRow[] }
  | {
      ok: false;
      /** True when the bytes are not decodable, parseable JSON. */
      unparseable: boolean;
      sha256: string;
      errors: AplioExportIssue[];
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
export function toAplioRow(parsed: z.output<typeof aplioRowSchema>): AplioRow {
  return {
    aplioId: parsed.id,
    email: parsed.email,
    name: parsed.name,
    isAdmin: parsed.isAdmin,
    deletedAt: parsed.deletedAt,
    sgauthUserId: parsed.sgauthUserId ?? null,
  };
}

/**
 * Validates the whole export. Errors name the path and the rule, never the
 * value: ids and addresses are PII. A duplicate id is an error; a duplicate
 * address is not (the planner maps every such row to one user).
 */
export function validateAplioExport(
  raw: Uint8Array | string,
): AplioExportValidation {
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

  const parsed = aplioExportSchema.safeParse(json);
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

  const rows = parsed.data.map(toAplioRow);
  const errors: AplioExportIssue[] = [];
  const firstIndex = new Map<string, number>();
  rows.forEach((row, index) => {
    const first = firstIndex.get(row.aplioId);
    if (first === undefined) firstIndex.set(row.aplioId, index);
    else {
      errors.push({
        path: `[${index}].id`,
        message: `duplicate id (same as [${first}])`,
      });
    }
  });
  if (errors.length > 0)
    return { ok: false, unparseable: false, sha256, errors };
  return { ok: true, sha256, rows };
}

// ---------------------------------------------------------------------------
// The per-row decision
// ---------------------------------------------------------------------------

export type AplioExisting = {
  id: string;
  status: "ACTIVE" | "DEACTIVATED" | "DELETED";
  emailVerified: boolean;
};

export type AplioCreate = {
  email: string;
  name: string;
  emailVerified: true;
  legacyEmail: boolean;
  status: "ACTIVE";
  isAdmin: false;
};

export type AplioRowDecision =
  | { outcome: "create"; create: AplioCreate; notes: string[] }
  | { outcome: "merge"; userId: string; notes: string[] }
  | { outcome: "skip"; reason: SkipReason; notes: string[] };

export type SkipReason =
  | "tombstoned in SGAuth"
  | "existing SGAuth account unverified; not mapped";

function localPart(email: string): string {
  return email.slice(0, email.lastIndexOf("@"));
}

/**
 * What to do with one live Aplio user, given the SGAuth account at that
 * address, if any. The import and the dual-write endpoint share it, so a
 * dual-written user looks exactly like an imported one. Nothing here ever
 * grants admin: Aplio's `isAdmin` is product-level (APLIO-P04).
 */
export function planAplioRow(
  row: { email: string; name: string | null },
  existing?: AplioExisting,
): AplioRowDecision {
  const email = row.email.trim().toLowerCase();
  if (existing === undefined) {
    const trimmed = row.name?.trim() ?? "";
    const notes = trimmed === "" ? ["name defaulted"] : [];
    return {
      outcome: "create",
      create: {
        email,
        name: trimmed === "" ? localPart(email) : trimmed,
        // Aplio's emailed code proved the mailbox.
        emailVerified: true,
        legacyEmail: !isNortheasternEmail(email),
        status: "ACTIVE",
        isAdmin: false,
      },
      notes,
    };
  }
  if (existing.status === "DELETED") {
    return { outcome: "skip", reason: "tombstoned in SGAuth", notes: [] };
  }
  // An unverified account could have been pre-registered by someone else:
  // mapping an Aplio id to it would hand that person the Aplio data.
  if (!existing.emailVerified) {
    return {
      outcome: "skip",
      reason: "existing SGAuth account unverified; not mapped",
      notes: [],
    };
  }
  // A merge writes nothing, so a Chambers password survives.
  return {
    outcome: "merge",
    userId: existing.id,
    notes: existing.status === "DEACTIVATED" ? ["deactivated in SGAuth"] : [],
  };
}

// ---------------------------------------------------------------------------
// The import plan
// ---------------------------------------------------------------------------

export type AplioState = {
  /** Existing users by lower-cased email. */
  users: Map<string, AplioExisting>;
};

export type AplioOutcome = "create" | "merge" | "duplicate-in-source" | "skip";

export type PlannedAplioRow = {
  row: AplioRow;
  outcome: AplioOutcome;
  /** Why a row was skipped. */
  reasons: string[];
  notes: string[];
  /** The SGAuth user it maps to; null for a skip, and for a create until apply. */
  userId: string | null;
  /** Set on a create only. */
  create: AplioCreate | null;
};

export type AplioCounts = {
  rows: number;
  create: number;
  merge: number;
  duplicateInSource: number;
  skip: number;
  legacyEmails: number;
  nameDefaulted: number;
  /** Live rows Aplio marks admin: a handoff number for APLIO-P04. */
  aplioAdmins: number;
};

export type AplioPlan = {
  rows: PlannedAplioRow[];
  counts: AplioCounts;
};

const SOFT_DELETED = "soft-deleted in Aplio";

export function planAplioImport(
  rows: AplioRow[],
  state: AplioState,
): AplioPlan {
  // The first live row for an address decides; later ones follow it.
  const decided = new Map<string, PlannedAplioRow>();

  const planned = rows.map((row): PlannedAplioRow => {
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
    let entry: PlannedAplioRow;
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

function countPlanned(planned: PlannedAplioRow[]): AplioCounts {
  const counts: AplioCounts = {
    rows: planned.length,
    create: 0,
    merge: 0,
    duplicateInSource: 0,
    skip: 0,
    legacyEmails: 0,
    nameDefaulted: 0,
    aplioAdmins: 0,
  };
  for (const entry of planned) {
    if (entry.outcome === "duplicate-in-source") counts.duplicateInSource += 1;
    else counts[entry.outcome] += 1;
    if (entry.row.deletedAt === null && entry.row.isAdmin) {
      counts.aplioAdmins += 1;
    }
    if (entry.create !== null && entry.notes.includes("name defaulted")) {
      counts.nameDefaulted += 1;
    }
    if (isLegacyListed(entry)) counts.legacyEmails += 1;
  }
  return counts;
}

/** A created or merged row at an address outside @northeastern.edu. */
export function isLegacyListed(entry: PlannedAplioRow): boolean {
  return (
    (entry.outcome === "create" || entry.outcome === "merge") &&
    !isNortheasternEmail(entry.row.email)
  );
}
