import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { Prisma } from "@/generated/prisma/client";
import { can, type AuthzSubject } from "@/lib/authz";
import { normalizeEmail } from "@/lib/auth/policy";
import {
  MAX_ACTIVE_POSITIONS_PER_USER,
  positionKeySchema,
} from "@/lib/position-key";
import {
  NAME_MAX,
  rowIssue,
  type ImportRow,
  type ImportSummary,
  type RowIssue,
} from "@/lib/user-import/contract";
import type { ParsedRow } from "@/lib/user-import/csv";

/** The reads the plan makes. A `PrismaClient` and a transaction client both fit. */
export type PlanDb = Pick<
  Prisma.TransactionClient,
  "$queryRaw" | "userPosition"
>;

export interface PlannedRow {
  row: ImportRow;
  /** The existing account, or null for a row that creates one. */
  userId: string | null;
  /** The positions to insert, matching `row.addPositions` key for key. */
  positionIds: string[];
}

export interface ImportPlan {
  rows: PlannedRow[];
  summary: ImportSummary;
  digest: string;
}

interface UserRow extends AuthzSubject {
  email: string;
  name: string;
}

interface PositionRow {
  id: string;
  key: string;
  deletedAt: Date | null;
}

const emailSchema = z.email().max(320);

const sorted = <T>(values: Iterable<T>): T[] => [...values].sort();

/**
 * Reads the accounts and positions the file names. With `lock`, takes a share
 * lock on every row it returns, so a concurrent deletion or deactivation
 * waits for the import's transaction instead of slipping between the plan and
 * the writes. Rows are locked in id order, as `position-assignments` does.
 */
async function loadTargets(
  db: PlanDb,
  emails: string[],
  keys: string[],
  lock: boolean,
) {
  const forShare = lock ? Prisma.sql`FOR SHARE` : Prisma.empty;
  const users =
    emails.length === 0
      ? []
      : await db.$queryRaw<UserRow[]>`
          SELECT "id", "email", "name", "status", "isAdmin", "isPrimaryAdmin"
          FROM "User"
          WHERE "email" IN (${Prisma.join(emails)})
          ORDER BY "id"
          ${forShare}`;
  const positions =
    keys.length === 0
      ? []
      : await db.$queryRaw<PositionRow[]>`
          SELECT "id", "key", "deletedAt"
          FROM "Position"
          WHERE "key" IN (${Prisma.join(keys)})
          ORDER BY "id"
          ${forShare}`;
  return { users, positions };
}

/**
 * Validates the rows against the database, classifies each one, and digests the
 * result. Writes nothing. Import is additive: it creates missing users and adds
 * missing assignments, and never renames, unassigns or reactivates, so
 * running the same file again plans no work.
 */
export async function buildImportPlan(
  parsed: readonly ParsedRow[],
  actor: AuthzSubject,
  { db, lock = false }: { db: PlanDb; lock?: boolean },
): Promise<ImportPlan> {
  const emails = parsed.map((row) => normalizeEmail(row.email));
  const lookupEmails = [
    ...new Set(emails.filter((email) => emailSchema.safeParse(email).success)),
  ];
  const lookupKeys = [
    ...new Set(
      parsed
        .flatMap((row) => row.positions)
        .filter((key) => positionKeySchema.safeParse(key).success),
    ),
  ];

  const { users, positions } = await loadTargets(
    db,
    lookupEmails,
    lookupKeys,
    lock,
  );
  const userByEmail = new Map(
    users.map((user) => [user.email.toLowerCase(), user]),
  );
  // A key can match a deleted position and, later, an active one.
  const activeByKey = new Map<string, PositionRow>();
  const deletedKeys = new Set<string>();
  for (const position of positions) {
    if (position.deletedAt === null) activeByKey.set(position.key, position);
    else deletedKeys.add(position.key);
  }

  const held = new Map<string, Set<string>>();
  if (users.length > 0) {
    const holdings = await db.userPosition.findMany({
      where: {
        userId: { in: users.map((user) => user.id) },
        position: { deletedAt: null },
      },
      select: { userId: true, positionId: true },
    });
    for (const { userId, positionId } of holdings) {
      const set = held.get(userId) ?? new Set<string>();
      set.add(positionId);
      held.set(userId, set);
    }
  }

  const firstLine = new Map<string, number>();
  const planned = parsed.map((row, index): PlannedRow => {
    const email = emails[index] ?? "";
    const errors: RowIssue[] = [];

    let user: UserRow | undefined;
    if (!emailSchema.safeParse(email).success) {
      errors.push(rowIssue("INVALID_EMAIL"));
    } else {
      const earlier = firstLine.get(email);
      if (earlier === undefined) firstLine.set(email, row.line);
      else errors.push(rowIssue("DUPLICATE_EMAIL", { line: earlier }));
      user = userByEmail.get(email);
    }

    const toAdd: PositionRow[] = [];
    for (const key of row.positions) {
      if (!positionKeySchema.safeParse(key).success) {
        errors.push(rowIssue("INVALID_POSITION_KEY", { key }));
        continue;
      }
      const position = activeByKey.get(key);
      if (position) toAdd.push(position);
      else {
        errors.push(
          rowIssue(
            deletedKeys.has(key) ? "DELETED_POSITION" : "UNKNOWN_POSITION",
            {
              key,
            },
          ),
        );
      }
    }

    if (!user) {
      // Only an address that parses can name a new account.
      if (errors.every((error) => error.code !== "INVALID_EMAIL")) {
        if (!can(actor, "accessAdmin").allowed) {
          errors.push(rowIssue("NOT_PERMITTED", { reason: "NOT_ADMIN" }));
        }
        if (row.name === "") errors.push(rowIssue("NAME_REQUIRED"));
        else if (row.name.length > NAME_MAX) {
          errors.push(rowIssue("NAME_TOO_LONG"));
        }
        if (toAdd.length > MAX_ACTIVE_POSITIONS_PER_USER) {
          errors.push(rowIssue("POSITION_LIMIT", { count: toAdd.length }));
        }
      }
      return finish(row, email, null, errors, toAdd, "create");
    }

    if (user.status === "DELETED") errors.push(rowIssue("ACCOUNT_DELETED"));
    else if (user.status === "DEACTIVATED") {
      errors.push(rowIssue("ACCOUNT_DEACTIVATED"));
    }

    const holding = held.get(user.id) ?? new Set<string>();
    // A position the user already holds is the idempotency path: dropped silently.
    const incoming = toAdd.filter((position) => !holding.has(position.id));
    if (user.status === "ACTIVE" && incoming.length > 0) {
      const decision = can(actor, "assignPosition", user);
      if (!decision.allowed) {
        errors.push(rowIssue("NOT_PERMITTED", { reason: decision.reason }));
      }
      const total = holding.size + incoming.length;
      if (total > MAX_ACTIVE_POSITIONS_PER_USER) {
        errors.push(rowIssue("POSITION_LIMIT", { count: total }));
      }
    }
    const planRow = finish(
      row,
      email,
      user.id,
      errors,
      incoming,
      incoming.length > 0 ? "update" : "unchanged",
    );
    if (user.name !== row.name && row.name !== "") {
      planRow.row.nameDiffers = true;
    }
    return planRow;
  });

  const summary = summarize(planned);
  return { rows: planned, summary, digest: digestOf(planned, activeByKey) };
}

function finish(
  row: ParsedRow,
  email: string,
  userId: string | null,
  errors: RowIssue[],
  toAdd: PositionRow[],
  action: "create" | "update" | "unchanged",
): PlannedRow {
  const invalid = errors.length > 0;
  return {
    userId,
    positionIds: invalid ? [] : toAdd.map((position) => position.id),
    row: {
      line: row.line,
      email,
      name: row.name,
      action: invalid ? "invalid" : action,
      addPositions: invalid ? [] : toAdd.map((position) => position.key),
      errors,
    },
  };
}

function summarize(planned: readonly PlannedRow[]): ImportSummary {
  const count = (action: ImportRow["action"]) =>
    planned.filter((entry) => entry.row.action === action).length;
  const invalid = count("invalid");
  return {
    rows: planned.length,
    valid: planned.length - invalid,
    invalid,
    create: count("create"),
    update: count("update"),
    unchanged: count("unchanged"),
    assignments: planned.reduce(
      (total, entry) => total + entry.positionIds.length,
      0,
    ),
  };
}

/**
 * SHA-256 of what apply would do: per row its line, email, action, added keys
 * and error codes, plus the key to position id map the keys resolved through.
 * A position deleted or created between preview and apply changes it.
 */
function digestOf(
  planned: readonly PlannedRow[],
  positions: ReadonlyMap<string, PositionRow>,
): string {
  const canonical = {
    rows: planned.map(({ row }) => [
      row.line,
      row.email,
      row.action,
      sorted(row.addPositions),
      sorted(row.errors.map((error) => error.code)),
    ]),
    positions: sorted(
      [...positions.values()].map(
        (position) => `${position.key}=${position.id}`,
      ),
    ),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}
