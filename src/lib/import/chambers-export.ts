import { createHash } from "node:crypto";
import { z } from "zod";

// The Chambers user export: one versioned, source-neutral JSON file, and the
// single contract the import script (#99) parses against. Pure on purpose: no
// filesystem, no env, no database, no `server-only`, so `tsx` scripts and tests
// can load it. See docs/runbooks/chambers-export.md.

/** `users_admin_role_check` on Chambers' Neon database (after 0015_sbp_admin_role.sql). */
export const NEON_ADMIN_ROLES = [
  "Executive Vice President",
  "Vice President of Operational Affairs",
  "Comptroller",
  "Digital Innovation Manager",
  "Information Manager",
  "Student Body President",
] as const;

/** `users_admin_role_check` as the Supabase project was frozen with it. */
export const SUPABASE_ADMIN_ROLES = [
  "Executive Vice President",
  "Vice President of Operational Affairs",
  "Comptroller",
  "Digital Innovation Manager",
  "Information Manager",
  "Digital Innovation Project Member",
] as const;

/** The two roles a board membership can carry in the export. */
export const BOARD_ROLES = ["Leadership", "Member"] as const;

/** A full 60-character bcrypt string, `$2a$` or `$2b$`, cost 04 to 31. */
export const BCRYPT_EXPORT_HASH =
  /^\$2[ab]\$(0[4-9]|[12]\d|3[01])\$[./A-Za-z0-9]{53}$/;

const datetime = z.iso.datetime({ offset: true });

const boardMembershipSchema = z.strictObject({
  body_id: z.guid(),
  body_name: z.string().trim().min(1),
  role: z.enum(BOARD_ROLES),
});

const userSchema = z.strictObject({
  id: z.guid(),
  email: z.email(),
  full_name: z.string().trim().min(1),
  password_hash: z
    .string()
    .regex(BCRYPT_EXPORT_HASH, "not a $2a$/$2b$ bcrypt hash")
    .nullable(),
  email_verified: z.boolean(),
  email_confirmed_at: datetime.nullable(),
  last_sign_in_at: datetime.nullable(),
  banned_until: z.union([z.literal("infinity"), datetime]).nullable(),
  is_active: z.boolean(),
  admin_role: z.string().nullable(),
  iems_role: z.string().min(1).nullable(),
  created_at: datetime,
  board_memberships: z.array(boardMembershipSchema),
});

export const chambersExportSchema = z
  .strictObject({
    format: z.literal("sgauth-chambers-export"),
    version: z.literal(1),
    source: z.enum(["chambers-neon", "supabase"]),
    exported_at: datetime,
    users: z.array(userSchema),
  })
  .superRefine((value, ctx) => {
    const allowed: readonly string[] =
      value.source === "chambers-neon"
        ? NEON_ADMIN_ROLES
        : SUPABASE_ADMIN_ROLES;
    value.users.forEach((user, index) => {
      if (user.admin_role !== null && !allowed.includes(user.admin_role)) {
        ctx.addIssue({
          code: "custom",
          path: ["users", index, "admin_role"],
          message: `admin_role is not allowed for source "${value.source}"`,
        });
      }
    });
  });

export type ChambersExport = z.infer<typeof chambersExportSchema>;
export type ChambersExportUser = ChambersExport["users"][number];

export type ExportExpectations = {
  expectUsers?: number;
  expectMemberships?: number;
  expectHashes?: number;
};

export type ExportIssue = {
  path: string;
  message: string;
  /** The row's id, when the row has a well-formed one. */
  id?: string;
};

export type ExportCounts = {
  users: number;
  active: number;
  inactive: number;
  emailVerified: number;
  banned: number;
  hashes: number;
  nullHashes: number;
  hashes2a: number;
  hashes2b: number;
  adminRoles: Record<string, number>;
  withIemsRole: number;
  memberships: number;
  distinctBodies: number;
  leadership: number;
  member: number;
};

export type ExportValidation = {
  ok: boolean;
  /** True when the bytes are not decodable, parseable JSON. */
  unparseable: boolean;
  /** SHA-256 (hex) of the exact bytes validated. */
  sha256: string;
  errors: ExportIssue[];
  warnings: string[];
  counts: ExportCounts;
  source?: string;
  exportedAt?: string;
  data?: ChambersExport;
};

const UUID_SHAPE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function emptyCounts(): ExportCounts {
  return {
    users: 0,
    active: 0,
    inactive: 0,
    emailVerified: 0,
    banned: 0,
    hashes: 0,
    nullHashes: 0,
    hashes2a: 0,
    hashes2b: 0,
    adminRoles: {},
    withIemsRole: 0,
    memberships: 0,
    distinctBodies: 0,
    leadership: 0,
    member: 0,
  };
}

function formatPath(path: ReadonlyArray<PropertyKey>): string {
  let out = "";
  for (const segment of path) {
    if (typeof segment === "number") out += `[${segment}]`;
    else out += out === "" ? String(segment) : `.${String(segment)}`;
  }
  return out === "" ? "$" : out;
}

function rowId(
  raw: unknown,
  path: ReadonlyArray<PropertyKey>,
): string | undefined {
  if (path[0] !== "users" || typeof path[1] !== "number") return undefined;
  if (typeof raw !== "object" || raw === null) return undefined;
  const users = (raw as { users?: unknown }).users;
  if (!Array.isArray(users)) return undefined;
  const row: unknown = users[path[1]];
  if (typeof row !== "object" || row === null) return undefined;
  const id = (row as { id?: unknown }).id;
  return typeof id === "string" && UUID_SHAPE.test(id) ? id : undefined;
}

function computeCounts(data: ChambersExport): ExportCounts {
  const counts = emptyCounts();
  const exportedAt = Date.parse(data.exported_at);
  const bodies = new Set<string>();
  for (const user of data.users) {
    counts.users += 1;
    if (user.is_active) counts.active += 1;
    else counts.inactive += 1;
    if (user.email_verified) counts.emailVerified += 1;
    if (
      user.banned_until === "infinity" ||
      (user.banned_until !== null && Date.parse(user.banned_until) > exportedAt)
    ) {
      counts.banned += 1;
    }
    if (user.password_hash === null) counts.nullHashes += 1;
    else {
      counts.hashes += 1;
      if (user.password_hash.startsWith("$2a$")) counts.hashes2a += 1;
      else counts.hashes2b += 1;
    }
    if (user.admin_role !== null) {
      counts.adminRoles[user.admin_role] =
        (counts.adminRoles[user.admin_role] ?? 0) + 1;
    }
    if (user.iems_role !== null) counts.withIemsRole += 1;
    for (const membership of user.board_memberships) {
      counts.memberships += 1;
      bodies.add(membership.body_id);
      if (membership.role === "Leadership") counts.leadership += 1;
      else counts.member += 1;
    }
  }
  counts.distinctBodies = bodies.size;
  return counts;
}

// Cross-row invariants. Messages name the rule and the row indexes, never the
// offending value: ids and emails are PII.
function crossRowErrors(data: ChambersExport): ExportIssue[] {
  const errors: ExportIssue[] = [];
  const ids = new Map<string, number>();
  const emails = new Map<string, number>();
  const bodyNames = new Map<string, { name: string; row: number }>();

  data.users.forEach((user, index) => {
    const firstId = ids.get(user.id);
    if (firstId === undefined) ids.set(user.id, index);
    else {
      errors.push({
        path: `users[${index}].id`,
        id: user.id,
        message: `duplicate id (same as users[${firstId}])`,
      });
    }

    const key = user.email.trim().toLowerCase();
    const firstEmail = emails.get(key);
    if (firstEmail === undefined) emails.set(key, index);
    else {
      errors.push({
        path: `users[${index}].email`,
        id: user.id,
        message: `duplicate email, compared case-insensitively (same as users[${firstEmail}])`,
      });
    }

    const seenBodies = new Set<string>();
    user.board_memberships.forEach((membership, m) => {
      const where = `users[${index}].board_memberships[${m}]`;
      if (seenBodies.has(membership.body_id)) {
        errors.push({
          path: `${where}.body_id`,
          id: user.id,
          message: "duplicate body_id within this user's memberships",
        });
      }
      seenBodies.add(membership.body_id);

      const known = bodyNames.get(membership.body_id);
      if (known === undefined) {
        bodyNames.set(membership.body_id, {
          name: membership.body_name,
          row: index,
        });
      } else if (known.name !== membership.body_name) {
        errors.push({
          path: `${where}.body_name`,
          id: user.id,
          message: `body_name differs from the same body_id on users[${known.row}]`,
        });
      }
    });
  });
  return errors;
}

function expectationErrors(
  counts: ExportCounts,
  opts: ExportExpectations,
): ExportIssue[] {
  const checks: Array<[string, number | undefined, number]> = [
    ["--expect-users", opts.expectUsers, counts.users],
    ["--expect-memberships", opts.expectMemberships, counts.memberships],
    ["--expect-hashes", opts.expectHashes, counts.hashes],
  ];
  const errors: ExportIssue[] = [];
  for (const [flag, expected, actual] of checks) {
    if (expected !== undefined && expected !== actual) {
      errors.push({
        path: flag,
        message: `count mismatch: expected ${expected}, got ${actual}`,
      });
    }
  }
  return errors;
}

function warningsFor(data: ChambersExport, counts: ExportCounts): string[] {
  const warnings: string[] = [];
  if (data.source === "supabase") {
    warnings.push(
      "source is supabase, the fallback: it may miss users created and passwords changed after chambers#136 (the Better Auth cutover)",
    );
  }
  const unnormalised = data.users.flatMap((user, index) =>
    user.email !== user.email.trim().toLowerCase() ? [index] : [],
  );
  if (unnormalised.length > 0) {
    const rows = unnormalised.slice(0, 10).map((i) => `users[${i}]`);
    const more = unnormalised.length > 10 ? ", ..." : "";
    warnings.push(
      `${unnormalised.length} email(s) are not lower-case and trimmed: ${rows.join(", ")}${more}`,
    );
  }
  if (counts.nullHashes > 0) {
    warnings.push(
      `${counts.nullHashes} user(s) have no password hash and import password-less`,
    );
  }
  const outside = data.users.filter(
    (user) => !user.email.trim().toLowerCase().endsWith("@northeastern.edu"),
  ).length;
  if (outside > 0) {
    warnings.push(`${outside} email(s) are outside @northeastern.edu`);
  }
  return warnings;
}

export function validateChambersExport(
  raw: Uint8Array | string,
  opts: ExportExpectations = {},
): ExportValidation {
  const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const base = { sha256, counts: emptyCounts(), warnings: [] as string[] };

  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  } catch {
    return {
      ...base,
      ok: false,
      unparseable: true,
      errors: [{ path: "$", message: "not valid JSON" }],
    };
  }

  const parsed = chambersExportSchema.safeParse(json);
  if (!parsed.success) {
    // Built from each issue's path and message only: never its input, which
    // could be a password hash.
    return {
      ...base,
      ok: false,
      unparseable: false,
      errors: parsed.error.issues.map((issue) => ({
        path: formatPath(issue.path),
        message: issue.message,
        id: rowId(json, issue.path),
      })),
    };
  }

  const data = parsed.data;
  const counts = computeCounts(data);
  const errors = [...crossRowErrors(data), ...expectationErrors(counts, opts)];
  return {
    ok: errors.length === 0,
    unparseable: false,
    sha256,
    errors,
    warnings: warningsFor(data, counts),
    counts,
    source: data.source,
    exportedAt: data.exported_at,
    data,
  };
}

const MAX_ERROR_LINES = 50;

export function formatReport(result: ExportValidation): string {
  const { counts, errors, warnings } = result;
  const lines: string[] = [];
  if (result.source !== undefined) lines.push(`Source:      ${result.source}`);
  if (result.exportedAt !== undefined) {
    lines.push(`Exported at: ${result.exportedAt}`);
  }
  lines.push(`SHA-256:     ${result.sha256}`);

  if (result.data !== undefined) {
    lines.push(
      "",
      `Users:       ${counts.users} (${counts.active} active, ${counts.inactive} inactive)`,
      `  email verified: ${counts.emailVerified}`,
      `  banned:         ${counts.banned}`,
      `Hashes:      ${counts.hashes} present (${counts.hashes2a} $2a$, ${counts.hashes2b} $2b$), ${counts.nullHashes} null`,
      "Admin roles:",
    );
    const roles = Object.entries(counts.adminRoles);
    if (roles.length === 0) lines.push("  (none)");
    for (const [role, n] of roles) lines.push(`  ${role}: ${n}`);
    lines.push(
      `IEMS roles:  ${counts.withIemsRole} user(s)`,
      `Memberships: ${counts.memberships} across ${counts.distinctBodies} bod${counts.distinctBodies === 1 ? "y" : "ies"} (${counts.leadership} Leadership, ${counts.member} Member)`,
    );
  }

  if (warnings.length > 0) {
    lines.push("", "Warnings:");
    for (const warning of warnings) lines.push(`  - ${warning}`);
  }
  if (errors.length > 0) {
    lines.push("", "Errors:");
    for (const error of errors.slice(0, MAX_ERROR_LINES)) {
      const id = error.id === undefined ? "" : ` (id ${error.id})`;
      lines.push(`  - ${error.path}${id}: ${error.message}`);
    }
    if (errors.length > MAX_ERROR_LINES) {
      lines.push(`  ...and ${errors.length - MAX_ERROR_LINES} more`);
    }
  }
  lines.push("", result.ok ? "VALID" : "INVALID");
  return lines.join("\n");
}
