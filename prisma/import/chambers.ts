import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/index.js";
import { parseAuditEvent } from "../../src/lib/audit-catalog.js";
import {
  NORTHEASTERN_DOMAIN,
  isNortheasternEmail,
} from "../../src/lib/import/email-domain.js";
import {
  BOARD_ROLES,
  NEON_ADMIN_ROLES,
  SUPABASE_ADMIN_ROLES,
  validateChambersExport,
  type ChambersExport,
  type ChambersExportUser,
} from "../../src/lib/import/chambers-export.js";
import { positionKeySchema } from "../../src/lib/position-key";
import { UsageError } from "../seed/sync-env.js";

// The Chambers user import, behind scripts/import-users.ts. It reads the
// `sgauth-chambers-export` file (parsed only by #98's validator), plans every
// row, and applies the plan in one transaction. Like prisma/seed/positions.ts it
// takes its client as an argument, because src/lib is `server-only` and bound to
// the app singleton. Never reads process.env (ENGINEERING §2). Hashes live only
// in memory and in Account.password: never in a report, a log or an error. See
// docs/runbooks/chambers-import.md.

export { NORTHEASTERN_DOMAIN, isNortheasternEmail };
export const LEGACY_BCRYPT_PREFIX = "bcrypt$";

/** The input is unusable: bad file, bad mapping, unmapped roles, no approval. */
export class ImportInputError extends Error {}

/** Another writer created a user with an imported email between read and write. */
export class ImportConflictError extends Error {}

type ExportSource = ChambersExport["source"];
type UserStatus = "ACTIVE" | "DEACTIVATED" | "DELETED";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

export type ImportArgs = {
  source: string;
  mapping: string;
  emailReplacements: string | null;
  apply: boolean;
  out: string;
};

const VALUE_FLAGS = {
  "--source": "source",
  "--mapping": "mapping",
  "--email-replacements": "emailReplacements",
  "--out": "out",
} as const;

function defaultOutDir(now: Date): string {
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "")
    .replace("T", "-");
  return `.temp/chambers-import/${stamp}`;
}

export function parseImportArgs(
  argv: string[],
  now: Date = new Date(),
): ImportArgs {
  const values: Partial<
    Record<(typeof VALUE_FLAGS)[keyof typeof VALUE_FLAGS], string>
  > = {};
  let dryRun = false;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--dry-run" || arg === "--apply") {
      if (arg === "--dry-run" ? dryRun : apply) {
        throw new UsageError(`${arg} was given more than once`);
      }
      if (arg === "--dry-run") dryRun = true;
      else apply = true;
    } else if (arg in VALUE_FLAGS) {
      const name = VALUE_FLAGS[arg as keyof typeof VALUE_FLAGS];
      if (values[name] !== undefined) {
        throw new UsageError(`${arg} was given more than once`);
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      values[name] = value;
      i += 1;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (values.source === undefined) throw new UsageError("--source is required");
  if (values.mapping === undefined) {
    throw new UsageError("--mapping is required");
  }
  if (dryRun === apply) {
    throw new UsageError("Give exactly one of --dry-run or --apply");
  }
  return {
    source: values.source,
    mapping: values.mapping,
    emailReplacements: values.emailReplacements ?? null,
    apply,
    out: values.out ?? defaultOutDir(now),
  };
}

// ---------------------------------------------------------------------------
// Loaders
// ---------------------------------------------------------------------------

function sha256Of(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readBytes(path: string, what: string): Promise<Buffer> {
  try {
    return await readFile(path);
  } catch {
    throw new ImportInputError(`Cannot read the ${what} file`);
  }
}

export type LoadedSource = {
  data: ChambersExport;
  sha256: string;
  warnings: string[];
};

export async function loadSource(path: string): Promise<LoadedSource> {
  const bytes = await readBytes(path, "source");
  const result = validateChambersExport(bytes);
  if (result.unparseable) {
    throw new ImportInputError("source is not valid JSON");
  }
  if (!result.ok || result.data === undefined) {
    const lines = result.errors.map((error) => {
      const id = error.id === undefined ? "" : ` (id ${error.id})`;
      return `  - ${error.path}${id}: ${error.message}`;
    });
    throw new ImportInputError(
      `The source file is not a valid export:\n${lines.join("\n")}`,
    );
  }
  return {
    data: result.data,
    sha256: result.sha256,
    warnings: result.warnings,
  };
}

const ADMIN_ROLE_VALUES: readonly string[] = [
  ...new Set([...NEON_ADMIN_ROLES, ...SUPABASE_ADMIN_ROLES]),
];

const BOARD_KEY_FORM =
  "board key must be board:<body_id>:Leadership or board:<body_id>:Member";

export function boardKey(bodyId: string, role: string): string {
  return `board:${bodyId}:${role}`;
}

/** The problem with a mapping key, or null when it is well formed. */
function roleKeyProblem(key: string): string | null {
  if (key.startsWith("admin_role:")) {
    const value = key.slice("admin_role:".length);
    return ADMIN_ROLE_VALUES.includes(value)
      ? null
      : "admin_role value is not a role the export validator allows";
  }
  if (key.startsWith("iems_role:")) {
    return key.length > "iems_role:".length ? null : "iems_role value is empty";
  }
  if (key.startsWith("board:")) {
    const rest = key.slice("board:".length);
    const split = rest.lastIndexOf(":");
    if (split === -1) return BOARD_KEY_FORM;
    const bodyId = rest.slice(0, split);
    const role = rest.slice(split + 1);
    if (!z.guid().safeParse(bodyId).success) {
      return "board key body_id is not a uuid";
    }
    return (BOARD_ROLES as readonly string[]).includes(role)
      ? null
      : BOARD_KEY_FORM;
  }
  return "key must start with admin_role:, iems_role: or board:";
}

const mappingFileSchema = z.strictObject({
  $comment: z.string().optional(),
  approvedBy: z.email().optional(),
  approvedAt: z.iso.date().optional(),
  roles: z.record(z.string(), z.unknown()),
});

export type ImportMapping = {
  approvedBy: string | null;
  approvedAt: string | null;
  /** Role key to position keys, de-duplicated within each list. */
  roles: Map<string, string[]>;
  sha256: string;
};

export async function loadMapping(path: string): Promise<ImportMapping> {
  const bytes = await readBytes(path, "mapping");
  let raw: unknown;
  try {
    raw = JSON.parse(bytes.toString("utf8"));
  } catch {
    throw new ImportInputError("mapping is not valid JSON");
  }
  const file = mappingFileSchema.safeParse(raw);
  if (!file.success) {
    throw new ImportInputError(
      `Invalid mapping file:\n${file.error.issues
        .map((issue) => `  - ${issue.path.join(".") || "$"}: ${issue.message}`)
        .join("\n")}`,
    );
  }

  const problems: string[] = [];
  const roles = new Map<string, string[]>();
  for (const [key, value] of Object.entries(file.data.roles)) {
    const keyProblem = roleKeyProblem(key);
    if (keyProblem !== null) problems.push(`roles["${key}"]: ${keyProblem}`);
    const positions = z.array(positionKeySchema).safeParse(value);
    if (!positions.success) {
      for (const issue of positions.error.issues) {
        problems.push(
          `roles["${key}"]${issue.path.map((p) => `[${String(p)}]`).join("")}: ${issue.message}`,
        );
      }
      continue;
    }
    const unique = new Set(positions.data);
    if (unique.size !== positions.data.length) {
      problems.push(`roles["${key}"]: duplicate position key`);
    }
    roles.set(key, [...unique]);
  }
  if (problems.length > 0) {
    throw new ImportInputError(
      `The mapping is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return {
    approvedBy: file.data.approvedBy ?? null,
    approvedAt: file.data.approvedAt ?? null,
    roles,
    sha256: sha256Of(bytes),
  };
}

/** Old address to its replacement, with the line it came from. */
export type Replacements = Map<string, { email: string; line: number }>;

export type LoadedReplacements = {
  replacements: Replacements;
  sha256: string;
  count: number;
};

const emailSchema = z.email();

export async function loadEmailReplacements(
  path: string,
): Promise<LoadedReplacements> {
  const bytes = await readBytes(path, "email replacements");
  const replacements: Replacements = new Map();
  const targets = new Set<string>();
  const problems: string[] = [];

  bytes
    .toString("utf8")
    .split("\n")
    .forEach((rawLine, index) => {
      const line = rawLine.replace(/\r$/, "").trim();
      if (line === "" || line.startsWith("#")) return;
      const number = index + 1;
      const fields = line.split(/[,\s]+/);
      if (fields.length !== 2) {
        problems.push(`line ${number}: expected exactly two addresses`);
        return;
      }
      const [from, to] = fields.map((field) => field.trim().toLowerCase());
      const before = problems.length;
      if (!emailSchema.safeParse(from).success) {
        problems.push(`line ${number}: the old address is not a valid email`);
      } else if (isNortheasternEmail(from)) {
        problems.push(
          `line ${number}: the old address is already @${NORTHEASTERN_DOMAIN}`,
        );
      }
      if (!emailSchema.safeParse(to).success) {
        problems.push(`line ${number}: the new address is not a valid email`);
      } else if (!isNortheasternEmail(to)) {
        problems.push(
          `line ${number}: the new address must be @${NORTHEASTERN_DOMAIN}`,
        );
      }
      if (from === to) {
        problems.push(`line ${number}: the old and new addresses are equal`);
      }
      if (replacements.has(from)) {
        problems.push(`line ${number}: the old address is listed twice`);
      }
      if (targets.has(to)) {
        problems.push(
          `line ${number}: the new address is already the target of another line`,
        );
      }
      if (problems.length === before) {
        replacements.set(from, { email: to, line: number });
        targets.add(to);
      }
    });

  if (problems.length > 0) {
    throw new ImportInputError(
      `The email replacement file is invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return { replacements, sha256: sha256Of(bytes), count: replacements.size };
}

// ---------------------------------------------------------------------------
// Rows
// ---------------------------------------------------------------------------

export type ImportRow = {
  chambersId: string;
  /** The address as Chambers has it, trimmed and lower-cased. */
  sourceEmail: string;
  /** The address SGAuth will use, or null for a non-northeastern row. */
  email: string | null;
  emailReplaced: boolean;
  name: string;
  bcryptHash: string | null;
  emailVerified: boolean;
  banned: boolean;
  active: boolean;
  roles: string[];
  /** body_id to body_name: console labels only. */
  boardNames: Map<string, string>;
};

/** The only function that reads export fields. */
export function toImportRow(
  user: ChambersExportUser,
  replacements: Replacements,
  now: Date,
): ImportRow {
  const sourceEmail = user.email.trim().toLowerCase();
  const replacement = replacements.get(sourceEmail);
  const northeastern = isNortheasternEmail(sourceEmail);
  const emailReplaced = !northeastern && replacement !== undefined;
  const email = northeastern ? sourceEmail : (replacement?.email ?? null);

  const roles: string[] = [];
  if (user.admin_role !== null) roles.push(`admin_role:${user.admin_role}`);
  if (user.iems_role !== null) roles.push(`iems_role:${user.iems_role}`);
  const boardNames = new Map<string, string>();
  for (const membership of user.board_memberships) {
    roles.push(boardKey(membership.body_id, membership.role));
    boardNames.set(membership.body_id, membership.body_name);
  }

  return {
    chambersId: user.id,
    sourceEmail,
    email,
    emailReplaced,
    name: user.full_name,
    bcryptHash: user.password_hash,
    // Chambers verified the old address, not the replacement.
    emailVerified: user.email_verified && !emailReplaced,
    banned:
      user.banned_until === "infinity" ||
      (user.banned_until !== null &&
        Date.parse(user.banned_until) > now.getTime()),
    active: user.is_active,
    roles,
    boardNames,
  };
}

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

export type ImportState = {
  /** Existing users by lower-cased email. */
  users: Map<
    string,
    { id: string; status: UserStatus; emailVerified: boolean }
  >;
  /** `credential` Accounts by user id. */
  credentials: Map<string, { id: string; password: string | null }>;
  /** Position ids each user holds, by user id. */
  holdings: Map<string, Set<string>>;
  /** Active positions among the mapping's keys, key to id. */
  positions: Map<string, string>;
};

type Reader = Pick<
  Prisma.TransactionClient,
  "user" | "account" | "userPosition" | "position"
>;

function mappedPositionKeys(mapping: ImportMapping): string[] {
  return [...new Set([...mapping.roles.values()].flat())];
}

export async function readImportState(
  db: Reader,
  rows: ImportRow[],
  mapping: ImportMapping,
): Promise<ImportState> {
  const emails = [
    ...new Set(rows.flatMap((row) => (row.email === null ? [] : [row.email]))),
  ];
  const users = await db.user.findMany({
    where: { email: { in: emails } },
    select: { id: true, email: true, status: true, emailVerified: true },
  });
  const userIds = users.map((user) => user.id);
  const [accounts, held, positions] = await Promise.all([
    db.account.findMany({
      where: { userId: { in: userIds }, providerId: "credential" },
      select: { id: true, userId: true, password: true },
    }),
    db.userPosition.findMany({
      where: { userId: { in: userIds } },
      select: { userId: true, positionId: true },
    }),
    db.position.findMany({
      where: { deletedAt: null, key: { in: mappedPositionKeys(mapping) } },
      select: { id: true, key: true },
    }),
  ]);

  const holdings = new Map<string, Set<string>>();
  for (const { userId, positionId } of held) {
    const set = holdings.get(userId) ?? new Set<string>();
    set.add(positionId);
    holdings.set(userId, set);
  }
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
    credentials: new Map(
      accounts.map((account) => [
        account.userId,
        { id: account.id, password: account.password },
      ]),
    ),
    holdings,
    positions: new Map(
      positions.map((position) => [position.key, position.id]),
    ),
  };
}

// ---------------------------------------------------------------------------
// Plan
// ---------------------------------------------------------------------------

export type RowOutcome = "create" | "merge" | "unchanged" | "skip";

export type PlannedRow = {
  row: ImportRow;
  outcome: RowOutcome;
  /** Why a row was skipped. */
  reasons: string[];
  notes: string[];
  /** The existing user's id; filled in by apply for a created one. */
  userId: string | null;
  /** The status a created user gets. */
  status: "ACTIVE" | "DEACTIVATED" | null;
  /** A merge adds a credential Account, or fills a null-password one. */
  credential: "create" | "fill" | null;
  credentialAccountId: string | null;
  /** Position keys this row will newly assign. */
  positionKeys: string[];
};

export type UnmappedRole = {
  key: string;
  rows: number;
  /** The body's name, for a board key. */
  bodyName: string | null;
};

export type ImportCounts = {
  rows: number;
  create: number;
  merge: number;
  unchanged: number;
  skip: number;
  nonNortheastern: number;
  emailsReplaced: number;
  positionsAssigned: number;
};

export type ImportPlan = {
  exportSource: ExportSource;
  rows: PlannedRow[];
  unmappedRoles: UnmappedRole[];
  disallowedAdminRoles: string[];
  unknownKeys: string[];
  /** Line numbers of replacement entries that match no export row. */
  unusedReplacements: number[];
  counts: ImportCounts;
};

export function planHasErrors(plan: ImportPlan): boolean {
  return (
    plan.unmappedRoles.length > 0 ||
    plan.disallowedAdminRoles.length > 0 ||
    plan.unknownKeys.length > 0
  );
}

function roleOrder(key: string): number {
  return (BOARD_ROLES as readonly string[]).indexOf(
    key.slice(key.lastIndexOf(":") + 1),
  );
}

function compareUnmapped(a: UnmappedRole, b: UnmappedRole): number {
  const aBoard = a.bodyName !== null;
  const bBoard = b.bodyName !== null;
  if (aBoard !== bBoard) return aBoard ? 1 : -1;
  if (!aBoard) return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
  const byName = a.bodyName!.localeCompare(b.bodyName!);
  if (byName !== 0) return byName;
  if (
    a.key.slice(0, a.key.lastIndexOf(":")) !==
    b.key.slice(0, b.key.lastIndexOf(":"))
  ) {
    return a.key < b.key ? -1 : 1;
  }
  return roleOrder(a.key) - roleOrder(b.key);
}

function unmappedRoles(
  rows: ImportRow[],
  mapping: ImportMapping,
): UnmappedRole[] {
  const counts = new Map<string, number>();
  const bodyNames = new Map<string, string>();
  for (const row of rows) {
    for (const [id, name] of row.boardNames) bodyNames.set(id, name);
    for (const key of row.roles) {
      if (!mapping.roles.has(key)) counts.set(key, (counts.get(key) ?? 0) + 1);
    }
  }
  return [...counts]
    .map(([key, n]): UnmappedRole => {
      const bodyName = key.startsWith("board:")
        ? (bodyNames.get(key.slice("board:".length, key.lastIndexOf(":"))) ??
          null)
        : null;
      return { key, rows: n, bodyName };
    })
    .sort(compareUnmapped);
}

const emptyPlanned = (row: ImportRow): PlannedRow => ({
  row,
  outcome: "unchanged",
  reasons: [],
  notes: [],
  userId: null,
  status: null,
  credential: null,
  credentialAccountId: null,
  positionKeys: [],
});

function skipped(row: ImportRow, reason: string): PlannedRow {
  return { ...emptyPlanned(row), outcome: "skip", reasons: [reason] };
}

/** The position keys the row's roles map to, de-duplicated, known ones only. */
function wantedPositionKeys(
  row: ImportRow,
  mapping: ImportMapping,
  state: ImportState,
): string[] {
  const keys = new Set<string>();
  for (const role of row.roles) {
    for (const key of mapping.roles.get(role) ?? []) {
      if (state.positions.has(key)) keys.add(key);
    }
  }
  return [...keys];
}

export function planImport(
  rows: ImportRow[],
  exportSource: ExportSource,
  mapping: ImportMapping,
  replacements: Replacements,
  state: ImportState,
): ImportPlan {
  const allowed: readonly string[] =
    exportSource === "chambers-neon" ? NEON_ADMIN_ROLES : SUPABASE_ADMIN_ROLES;
  const disallowedAdminRoles = [...mapping.roles.keys()].filter(
    (key) =>
      key.startsWith("admin_role:") &&
      !allowed.includes(key.slice("admin_role:".length)),
  );
  const unknownKeys = mappedPositionKeys(mapping)
    .filter((key) => !state.positions.has(key))
    .sort();

  const emailUses = new Map<string, number>();
  for (const row of rows) {
    if (!row.banned && row.email !== null) {
      emailUses.set(row.email, (emailUses.get(row.email) ?? 0) + 1);
    }
  }

  const planned = rows.map((row): PlannedRow => {
    if (row.banned) return skipped(row, "banned in Chambers");
    if (row.email === null) {
      return skipped(row, "non-northeastern email; no replacement supplied");
    }
    if ((emailUses.get(row.email) ?? 0) > 1) {
      return skipped(row, "duplicate email after replacement");
    }
    const existing = state.users.get(row.email);
    const wanted = wantedPositionKeys(row, mapping, state);
    const notes: string[] = [];
    if (row.emailReplaced) notes.push("email replaced");

    if (existing === undefined) {
      const status = row.active ? "ACTIVE" : "DEACTIVATED";
      if (row.bcryptHash === null) {
        notes.push("no password in export (must reset)");
      }
      if (status === "DEACTIVATED") {
        notes.push("deactivated in Chambers; no positions assigned");
      }
      const positionKeys = status === "ACTIVE" ? wanted : [];
      if (positionKeys.length > 0) {
        notes.push(`positions +${positionKeys.join(",")}`);
      }
      return {
        ...emptyPlanned(row),
        outcome: "create",
        notes,
        status,
        positionKeys,
      };
    }
    if (existing.status === "DELETED") {
      return skipped(row, "tombstoned in SGAuth");
    }

    // An unverified SGAuth account could have been pre-registered by someone
    // holding the Chambers user's address: never merge into it.
    if (!existing.emailVerified) {
      return {
        ...emptyPlanned(row),
        notes: [...notes, "existing SGAuth account unverified; not merged"],
        userId: existing.id,
      };
    }

    const account = state.credentials.get(existing.id);
    // An existing account is only touched when the export row proves ownership
    // of the address: Chambers verified it, and it was not replaced. Otherwise
    // the row could attach a password and positions to someone else's account.
    const provesOwnership = row.emailVerified && !row.emailReplaced;
    if (!provesOwnership) {
      notes.push("unverified in Chambers; credential not merged");
    }
    let credential: PlannedRow["credential"] = null;
    if (provesOwnership && row.bcryptHash !== null) {
      if (account === undefined) credential = "create";
      else if (account.password === null) credential = "fill";
    }
    const held = state.holdings.get(existing.id) ?? new Set<string>();
    let positionKeys: string[] = [];
    if (!provesOwnership) {
      // No positions either: they rely on the same proof.
    } else if (existing.status === "ACTIVE") {
      positionKeys = wanted.filter(
        (key) => !held.has(state.positions.get(key)!),
      );
    } else if (wanted.length > 0) {
      notes.push("already deactivated in SGAuth; no positions assigned");
    }
    if (positionKeys.length > 0) {
      notes.push(`positions +${positionKeys.join(",")}`);
    }
    const changed = credential !== null || positionKeys.length > 0;
    return {
      ...emptyPlanned(row),
      outcome: changed ? "merge" : "unchanged",
      notes,
      userId: existing.id,
      credential,
      credentialAccountId: credential === "fill" ? account!.id : null,
      positionKeys,
    };
  });

  const sourceEmails = new Set(rows.map((row) => row.sourceEmail));
  const unusedReplacements = [...replacements]
    .filter(([old]) => !sourceEmails.has(old))
    .map(([, { line }]) => line)
    .sort((a, b) => a - b);

  return {
    exportSource,
    rows: planned,
    unmappedRoles: unmappedRoles(rows, mapping),
    disallowedAdminRoles,
    unknownKeys,
    unusedReplacements,
    counts: countPlanned(planned),
  };
}

function countPlanned(planned: PlannedRow[]): ImportCounts {
  const counts: ImportCounts = {
    rows: planned.length,
    create: 0,
    merge: 0,
    unchanged: 0,
    skip: 0,
    nonNortheastern: 0,
    emailsReplaced: 0,
    positionsAssigned: 0,
  };
  for (const entry of planned) {
    counts[entry.outcome] += 1;
    if (entry.outcome === "skip") {
      if (entry.row.email === null && !entry.row.banned) {
        counts.nonNortheastern += 1;
      }
      continue;
    }
    if (entry.row.emailReplaced) counts.emailsReplaced += 1;
    counts.positionsAssigned += entry.positionKeys.length;
  }
  return counts;
}

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

/**
 * Production refuses unless the mapping was approved by the current Primary
 * Admin. Any other environment gets a warning string instead of a refusal.
 */
export function checkApproval(
  mapping: ImportMapping,
  primaryAdminEmail: string | null,
  sgauthEnv: string,
): string | null {
  const approved =
    mapping.approvedBy !== null &&
    mapping.approvedAt !== null &&
    primaryAdminEmail !== null &&
    mapping.approvedBy.toLowerCase() === primaryAdminEmail.toLowerCase();
  if (approved) return null;
  const message =
    "The mapping is not approved: approvedBy must be the current Primary Admin, with approvedAt set";
  if (sgauthEnv === "production") throw new ImportInputError(message);
  return message;
}

export async function readPrimaryAdminEmail(
  db: Pick<Prisma.TransactionClient, "user">,
): Promise<string | null> {
  const admin = await db.user.findFirst({
    where: { isPrimaryAdmin: true },
    select: { email: true },
  });
  return admin?.email ?? null;
}

// ---------------------------------------------------------------------------
// Apply
// ---------------------------------------------------------------------------

export type ApplyInput = {
  rows: ImportRow[];
  exportSource: ExportSource;
  mapping: ImportMapping;
  replacements: Replacements;
  checksums: { source: string; replacements: string | null };
  now: Date;
};

export function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/**
 * Writes the plan in one transaction, re-planned from fresh reads, together with
 * the BULK_IMPORT event: if the audit write fails, everything rolls back.
 * Returns the plan that was applied, with the created users' ids filled in.
 */
export async function applyImport(
  db: PrismaClient,
  input: ApplyInput,
): Promise<ImportPlan> {
  const { rows, exportSource, mapping, replacements, checksums, now } = input;
  try {
    return await db.$transaction(
      async (tx) => {
        const state = await readImportState(tx, rows, mapping);
        const plan = planImport(
          rows,
          exportSource,
          mapping,
          replacements,
          state,
        );
        if (planHasErrors(plan)) {
          throw new ImportInputError(
            "The plan reports errors on re-read; re-run the dry run.",
          );
        }

        const creating = plan.rows.filter(
          (entry) => entry.outcome === "create",
        );
        const created = await tx.user.createManyAndReturn({
          data: creating.map((entry) => ({
            email: entry.row.email!,
            name: entry.row.name,
            emailVerified: entry.row.emailVerified,
            status: entry.status!,
            deactivatedAt: entry.status === "DEACTIVATED" ? now : null,
          })),
          select: { id: true, email: true },
        });
        const createdIds = new Map(
          created.map((user) => [user.email.toLowerCase(), user.id]),
        );
        const applied = plan.rows.map((entry) =>
          entry.outcome === "create"
            ? { ...entry, userId: createdIds.get(entry.row.email!)! }
            : entry,
        );

        const accounts = applied.filter(
          (entry) =>
            entry.row.bcryptHash !== null &&
            (entry.outcome === "create" || entry.credential === "create"),
        );
        if (accounts.length > 0) {
          await tx.account.createMany({
            data: accounts.map((entry) => ({
              userId: entry.userId!,
              providerId: "credential",
              accountId: entry.userId!,
              password: LEGACY_BCRYPT_PREFIX + entry.row.bcryptHash!,
            })),
          });
        }
        for (const entry of applied) {
          if (entry.credential === "fill") {
            await tx.account.updateMany({
              where: { id: entry.credentialAccountId!, password: null },
              data: { password: LEGACY_BCRYPT_PREFIX + entry.row.bcryptHash! },
            });
          }
        }

        const assignments = applied.flatMap((entry) =>
          entry.positionKeys.map((key) => ({
            userId: entry.userId!,
            positionId: state.positions.get(key)!,
            assignedById: null,
          })),
        );
        if (assignments.length > 0) {
          await tx.userPosition.createMany({
            data: assignments,
            skipDuplicates: true,
          });
        }

        await tx.auditEvent.create({
          data: parseAuditEvent({
            type: "BULK_IMPORT",
            actorType: "SYSTEM",
            metadata: {
              source: "chambers",
              exportSource,
              sourceSha256: checksums.source,
              mappingSha256: mapping.sha256,
              replacementsSha256: checksums.replacements,
              created: plan.counts.create,
              merged: plan.counts.merge,
              unchanged: plan.counts.unchanged,
              skipped: plan.counts.skip,
              emailsReplaced: plan.counts.emailsReplaced,
              positionsAssigned: plan.counts.positionsAssigned,
            },
          }),
        });
        return { ...plan, rows: applied };
      },
      // One transaction of batch statements: a handful of round trips even for a
      // few thousand rows. A timeout would roll the whole import back.
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

export type ReportMeta = {
  generatedAt: Date;
  dryRun: boolean;
  target: string;
  exportedAt: string;
  sourceSha256: string;
  mappingSha256: string;
  replacementsSha256: string | null;
};

/** No hash field anywhere: a test checks the serialised form. */
export function buildReport(plan: ImportPlan, meta: ReportMeta) {
  return {
    generatedAt: meta.generatedAt.toISOString(),
    dryRun: meta.dryRun,
    target: meta.target,
    exportSource: plan.exportSource,
    exportedAt: meta.exportedAt,
    sourceSha256: meta.sourceSha256,
    mappingSha256: meta.mappingSha256,
    replacementsSha256: meta.replacementsSha256,
    counts: plan.counts,
    unusedReplacementLines: plan.unusedReplacements,
    rows: plan.rows.map((entry) => ({
      chambersId: entry.row.chambersId,
      sourceEmail: entry.row.sourceEmail,
      email: entry.row.email,
      emailReplaced: entry.row.emailReplaced,
      outcome: entry.outcome,
      reasons: entry.reasons,
      notes: entry.notes,
    })),
  };
}

/** Created, merged and unchanged rows only: never a skipped one. */
export function buildIdMap(
  plan: ImportPlan,
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
              chambersId: entry.row.chambersId,
              sgauthId: entry.userId,
              email: entry.row.email,
              emailReplaced: entry.row.emailReplaced,
              outcome: entry.outcome,
            },
          ],
    ),
  };
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;

/** Console summary: row ids and counts only, never an email or a hash. */
export function formatImportSummary(plan: ImportPlan): string {
  const lines: string[] = [];
  for (const entry of plan.rows) {
    if (entry.outcome === "skip") {
      lines.push(`! skip ${entry.row.chambersId} ${entry.reasons.join("; ")}`);
    }
  }
  const { counts } = plan;
  if (counts.nonNortheastern > 0) {
    lines.push(
      `! ${counts.nonNortheastern} non-northeastern rows have no replacement; see report.json`,
    );
  }
  for (const line of plan.unusedReplacements) {
    lines.push(`? replacement line ${line} matches no export row`);
  }
  for (const role of plan.unmappedRoles) {
    const body = role.bodyName === null ? "" : ` "${role.bodyName}"`;
    lines.push(
      `? unmapped role ${role.key}${body} (${plural(role.rows, "row")})`,
    );
  }
  for (const role of plan.disallowedAdminRoles) {
    lines.push(`? ${role} is not a ${plan.exportSource} role`);
  }
  for (const key of plan.unknownKeys) {
    lines.push(`? unknown position key ${key}`);
  }
  lines.push(
    `${counts.rows} rows: ${counts.create} create, ${counts.merge} merge, ${counts.unchanged} unchanged, ${counts.skip} skip (${counts.nonNortheastern} non-northeastern); ${counts.emailsReplaced} emails replaced; ${counts.positionsAssigned} position assignments`,
  );
  return lines.join("\n");
}
