import "server-only";
import { z } from "zod";
import type { AuditEvent, Prisma, UserStatus } from "@/generated/prisma/client";
import {
  AUDIT_ACTOR_TYPES,
  AUDIT_EVENT_TYPES,
  AUDIT_TARGET_TYPES,
  type AuditActorType,
  type AuditTargetType,
} from "@/lib/audit-catalog";

// The audit log viewer and its CSV export share everything here: one filter
// schema, one `where` builder and one row mapper, so the file always matches
// what is on screen. Every query takes its client as an argument, and the file
// never imports `@/lib/prisma`, so the pure tests never parse env.

export const AUDIT_PAGE_SIZE = 50;
export const AUDIT_EXPORT_CAP = 50_000;
export const AUDIT_EXPORT_BATCH = 1_000;
export const AUDIT_TIME_ZONE = "America/New_York";

export type AuditLogDb = Pick<
  Prisma.TransactionClient,
  "auditEvent" | "user" | "position" | "product"
>;

// --- Time ---------------------------------------------------------------

function isRealDate(ymd: string): boolean {
  const [year, month, day] = ymd.split("-").map(Number);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function offsetMinutes(instant: Date, timeZone: string): number {
  const name = new Intl.DateTimeFormat("en-US", {
    timeZone,
    timeZoneName: "longOffset",
  })
    .formatToParts(instant)
    .find((part) => part.type === "timeZoneName")?.value;
  if (name === "GMT") return 0;
  const match = /^GMT([+-])(\d{2}):(\d{2})$/.exec(name ?? "");
  if (!match) throw new Error(`Unreadable UTC offset for ${timeZone}`);
  const minutes = Number(match[2]) * 60 + Number(match[3]);
  return match[1] === "-" ? -minutes : minutes;
}

/** The UTC instant of local midnight on `ymd` in `timeZone`. */
export function zonedDayStart(
  ymd: string,
  timeZone: string = AUDIT_TIME_ZONE,
): Date {
  const [year, month, day] = ymd.split("-").map(Number);
  const guess = Date.UTC(year, month - 1, day);
  // The offset at the guess can differ from the offset at local midnight on a
  // DST day, so read it again at the corrected instant.
  const first = guess - offsetMinutes(new Date(guess), timeZone) * 60_000;
  return new Date(guess - offsetMinutes(new Date(first), timeZone) * 60_000);
}

function nextDay(ymd: string): string {
  const [year, month, day] = ymd.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + 1))
    .toISOString()
    .slice(0, 10);
}

// --- Cursor -------------------------------------------------------------

export interface AuditCursor {
  createdAt: Date;
  id: string;
}

export function encodeCursor({ createdAt, id }: AuditCursor): string {
  return Buffer.from(`${createdAt.toISOString()}|${id}`).toString("base64url");
}

export function decodeCursor(value: string): AuditCursor | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  const parts = Buffer.from(value, "base64url").toString("utf8").split("|");
  if (parts.length !== 2) return null;
  const [iso, id] = parts;
  const createdAt = new Date(iso);
  if (Number.isNaN(createdAt.getTime()) || createdAt.toISOString() !== iso) {
    return null;
  }
  if (!z.uuid().safeParse(id).success) return null;
  return { createdAt, id };
}

function cursorWhere(cursor: AuditCursor): Prisma.AuditEventWhereInput {
  return {
    OR: [
      { createdAt: { lt: cursor.createdAt } },
      { createdAt: cursor.createdAt, id: { lt: cursor.id } },
    ],
  };
}

const ORDER = [{ createdAt: "desc" }, { id: "desc" }] as const;

// --- Filters ------------------------------------------------------------

export const AUDIT_USER_ROLES = ["any", "actor", "target"] as const;

const MESSAGES = {
  type: "Unknown event type.",
  user: "Enter an email or a user ID.",
  targetId: "Choose a target type for this ID.",
  date: "Enter a valid date.",
  to: "Choose a date on or after From.",
  cursor: "Invalid page marker.",
} as const;

type RawParams = Record<string, string | string[] | undefined>;

// A GET form submits every empty field as "", and one `type` value arrives as
// a bare string.
function normalizeParams(raw: unknown): unknown {
  if (typeof raw !== "object" || raw === null) return raw;
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as RawParams)) {
    if (value === "" || value === undefined) continue;
    out[key] = value;
  }
  if (typeof out.type === "string") out.type = [out.type];
  if (Array.isArray(out.type)) {
    out.type = out.type.filter((entry) => entry !== "");
  }
  return out;
}

const day = z
  .string(MESSAGES.date)
  .refine((value) => /^\d{4}-\d{2}-\d{2}$/.test(value) && isRealDate(value), {
    error: MESSAGES.date,
  });

/** True for a user id, false for an email address. */
export function isUserId(value: string): boolean {
  return z.uuid().safeParse(value).success;
}

const userRef = z
  .string(MESSAGES.user)
  .trim()
  .max(254, MESSAGES.user)
  .transform((value, ctx) => {
    if (isUserId(value) || z.email().safeParse(value).success) {
      return value.toLowerCase();
    }
    ctx.addIssue({ code: "custom", message: MESSAGES.user });
    return z.NEVER;
  });

const filterShape = {
  type: z
    .array(z.enum(AUDIT_EVENT_TYPES, MESSAGES.type))
    .max(AUDIT_EVENT_TYPES.length)
    .optional()
    .transform((types) => [...new Set(types ?? [])]),
  user: userRef.optional(),
  userRole: z.enum(AUDIT_USER_ROLES).default("any"),
  actorType: z.enum(AUDIT_ACTOR_TYPES).optional(),
  targetType: z.enum(AUDIT_TARGET_TYPES).optional(),
  targetId: z.string().trim().min(1).max(200).optional(),
  from: day.optional(),
  to: day.optional(),
};

function checkFilter(
  filter: {
    targetType?: string;
    targetId?: string;
    from?: string;
    to?: string;
  },
  ctx: z.RefinementCtx,
) {
  if (filter.targetId !== undefined && filter.targetType === undefined) {
    ctx.addIssue({
      code: "custom",
      message: MESSAGES.targetId,
      path: ["targetId"],
    });
  }
  if (filter.from && filter.to && filter.from > filter.to) {
    ctx.addIssue({ code: "custom", message: MESSAGES.to, path: ["to"] });
  }
}

export const auditLogFilterSchema = z.preprocess(
  normalizeParams,
  z.object(filterShape).superRefine(checkFilter),
);

export type AuditLogFilter = z.output<typeof auditLogFilterSchema>;

export const auditLogPageSchema = z.preprocess(
  normalizeParams,
  z
    .object({
      ...filterShape,
      cursor: z
        .string()
        .max(200, MESSAGES.cursor)
        .transform((value, ctx) => {
          const cursor = decodeCursor(value);
          if (!cursor) {
            ctx.addIssue({ code: "custom", message: MESSAGES.cursor });
            return z.NEVER;
          }
          return cursor;
        })
        .optional(),
    })
    .superRefine(checkFilter),
);

export type AuditLogPageQuery = z.output<typeof auditLogPageSchema>;

/**
 * The query string for a filter: non-default fields only, in a fixed order, one
 * `type` entry per type. The page's links and the export link are built from it,
 * so `parse(serialize(f))` equals `f`.
 */
export function serializeAuditFilter(filter: AuditLogFilter): URLSearchParams {
  const params = new URLSearchParams();
  for (const type of filter.type) params.append("type", type);
  if (filter.user) params.set("user", filter.user);
  if (filter.userRole !== "any") params.set("userRole", filter.userRole);
  if (filter.actorType) params.set("actorType", filter.actorType);
  if (filter.targetType) params.set("targetType", filter.targetType);
  if (filter.targetId) params.set("targetId", filter.targetId);
  if (filter.from) params.set("from", filter.from);
  if (filter.to) params.set("to", filter.to);
  return params;
}

/** Search params as Next hands them over, or a `URLSearchParams`. */
export function paramsToRecord(
  params: URLSearchParams,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const key of new Set(params.keys())) {
    const values = params.getAll(key);
    out[key] = key === "type" || values.length > 1 ? values : values[0];
  }
  return out;
}

// --- User resolution ----------------------------------------------------

/**
 * The user filter as an id. An id is used even when no such user exists,
 * because audit rows hold no foreign key; an unknown email has no id and
 * returns `null`.
 */
export async function resolveUserFilter(
  db: Pick<AuditLogDb, "user">,
  user: string,
): Promise<{ id: string; found: boolean } | null> {
  if (isUserId(user)) {
    const row = await db.user.findUnique({
      where: { id: user },
      select: { id: true },
    });
    return { id: user, found: row !== null };
  }
  // `email` is citext, so the lookup ignores case.
  const row = await db.user.findUnique({
    where: { email: user },
    select: { id: true },
  });
  return row ? { id: row.id, found: true } : null;
}

// --- Query --------------------------------------------------------------

/**
 * `userId` is the resolved id of `filter.user`; `null` means the filter named a
 * user that does not exist, which matches nothing.
 */
export function buildAuditWhere(
  filter: AuditLogFilter,
  userId: string | null | undefined,
): Prisma.AuditEventWhereInput {
  const and: Prisma.AuditEventWhereInput[] = [];

  if (filter.user !== undefined) {
    if (userId == null) return { id: { in: [] } };
    const actor = { actorUserId: userId };
    const target = { targetType: "USER", targetId: userId } as const;
    and.push(
      filter.userRole === "actor"
        ? actor
        : filter.userRole === "target"
          ? target
          : { OR: [actor, target] },
    );
  }
  if (filter.type.length > 0) and.push({ type: { in: filter.type } });
  if (filter.actorType) and.push({ actorType: filter.actorType });
  if (filter.targetType) and.push({ targetType: filter.targetType });
  if (filter.targetId) and.push({ targetId: filter.targetId });
  if (filter.from || filter.to) {
    and.push({
      createdAt: {
        ...(filter.from ? { gte: zonedDayStart(filter.from) } : {}),
        ...(filter.to ? { lt: zonedDayStart(nextDay(filter.to)) } : {}),
      },
    });
  }
  return { AND: and };
}

export interface PersonRef {
  id: string;
  name: string | null;
  email: string | null;
  status: UserStatus | null;
}

export interface AuditLogRow {
  id: string;
  /** ISO, UTC. */
  createdAt: string;
  /** As stored; it may predate the catalog. */
  type: string;
  actor: { type: AuditActorType; user: PersonRef | null };
  target: {
    type: AuditTargetType;
    id: string;
    label: string | null;
    user: PersonRef | null;
  } | null;
  ip: string | null;
  userAgent: string | null;
  metadata: Prisma.JsonValue;
}

/** Looks up every referenced user, position and product in one query each. */
export async function resolveRefs(
  db: AuditLogDb,
  rows: readonly AuditEvent[],
): Promise<AuditLogRow[]> {
  const userIds = new Set<string>();
  const positionIds = new Set<string>();
  const productIds = new Set<string>();
  for (const row of rows) {
    if (row.actorType === "USER" && row.actorUserId) {
      userIds.add(row.actorUserId);
    }
    if (!row.targetId) continue;
    if (row.targetType === "USER") userIds.add(row.targetId);
    if (row.targetType === "POSITION") positionIds.add(row.targetId);
    if (row.targetType === "PRODUCT") productIds.add(row.targetId);
  }

  const [users, positions, products] = await Promise.all([
    userIds.size > 0
      ? db.user.findMany({
          where: { id: { in: [...userIds] } },
          select: { id: true, name: true, email: true, status: true },
        })
      : [],
    positionIds.size > 0
      ? db.position.findMany({
          where: { id: { in: [...positionIds] } },
          select: { id: true, key: true, name: true },
        })
      : [],
    productIds.size > 0
      ? db.product.findMany({
          where: { id: { in: [...productIds] } },
          select: { id: true, slug: true, name: true },
        })
      : [],
  ]);

  const userById = new Map<string, PersonRef>(
    users.map((user) => [user.id, user]),
  );
  const positionLabel = new Map(
    positions.map((p) => [p.id, `${p.name} (${p.key})`]),
  );
  const productLabel = new Map(
    products.map((p) => [p.id, `${p.name} (${p.slug})`]),
  );
  // A user whose row is missing keeps its id and nothing else.
  const person = (id: string): PersonRef =>
    userById.get(id) ?? { id, name: null, email: null, status: null };

  return rows.map((row) => ({
    id: row.id,
    createdAt: row.createdAt.toISOString(),
    type: row.type,
    actor: {
      type: row.actorType,
      user:
        row.actorType === "USER" && row.actorUserId
          ? person(row.actorUserId)
          : null,
    },
    target:
      row.targetType && row.targetId
        ? {
            type: row.targetType,
            id: row.targetId,
            label:
              (row.targetType === "POSITION"
                ? positionLabel.get(row.targetId)
                : row.targetType === "PRODUCT"
                  ? productLabel.get(row.targetId)
                  : null) ?? null,
            user: row.targetType === "USER" ? person(row.targetId) : null,
          }
        : null,
    ip: row.ip,
    userAgent: row.userAgent,
    metadata: row.metadata,
  }));
}

export async function listAuditEvents(
  db: AuditLogDb,
  where: Prisma.AuditEventWhereInput,
  cursor?: AuditCursor,
): Promise<{ events: AuditLogRow[]; nextCursor: string | null }> {
  const rows = await db.auditEvent.findMany({
    where: cursor ? { AND: [where, cursorWhere(cursor)] } : where,
    orderBy: [...ORDER],
    take: AUDIT_PAGE_SIZE + 1,
  });
  const page = rows.slice(0, AUDIT_PAGE_SIZE);
  const last = page.at(-1);
  return {
    events: await resolveRefs(db, page),
    nextCursor:
      rows.length > AUDIT_PAGE_SIZE && last
        ? encodeCursor({ createdAt: last.createdAt, id: last.id })
        : null,
  };
}

/** Counts up to one past the export cap, so a huge table never pays for an exact count. */
export function countAuditEvents(
  db: Pick<AuditLogDb, "auditEvent">,
  where: Prisma.AuditEventWhereInput,
): Promise<number> {
  return db.auditEvent.count({ where, take: AUDIT_EXPORT_CAP + 1 });
}

// --- CSV ----------------------------------------------------------------

const FORMULA_START = /^[=+\-@\t\r]/;

export function csvCell(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  let text = String(value);
  // A spreadsheet runs a cell that starts with one of these as a formula.
  if (FORMULA_START.test(text)) text = `'${text}`;
  return /["\r\n,]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}

export const AUDIT_CSV_COLUMNS = [
  "id",
  "createdAt",
  "type",
  "actorType",
  "actorUserId",
  "actorName",
  "actorEmail",
  "targetType",
  "targetId",
  "targetLabel",
  "ip",
  "userAgent",
  "metadata",
] as const;

export function csvLine(row: AuditLogRow): string {
  const cells = [
    row.id,
    row.createdAt,
    row.type,
    row.actor.type,
    row.actor.user?.id,
    row.actor.user?.name,
    row.actor.user?.email,
    row.target?.type,
    row.target?.id,
    row.target?.label ?? row.target?.user?.email,
    row.ip,
    row.userAgent,
    JSON.stringify(row.metadata),
  ];
  return `${cells.map(csvCell).join(",")}\r\n`;
}

/**
 * The CSV as chunks: a BOM and header line, then one chunk per batch of up to
 * `AUDIT_EXPORT_BATCH` rows, newest first, `cap` rows at most. Pages by keyset,
 * like the table, so the file is the same list the table shows.
 */
export async function* exportAuditCsv(
  db: AuditLogDb,
  where: Prisma.AuditEventWhereInput,
  cap: number = AUDIT_EXPORT_CAP,
): AsyncGenerator<string> {
  yield `﻿${AUDIT_CSV_COLUMNS.join(",")}\r\n`;

  let sent = 0;
  let cursor: AuditCursor | undefined;
  while (sent < cap) {
    const take = Math.min(AUDIT_EXPORT_BATCH, cap - sent);
    const rows = await db.auditEvent.findMany({
      where: cursor ? { AND: [where, cursorWhere(cursor)] } : where,
      orderBy: [...ORDER],
      take,
    });
    if (rows.length > 0) {
      yield (await resolveRefs(db, rows)).map(csvLine).join("");
      sent += rows.length;
    }
    const last = rows.at(-1);
    if (!last || rows.length < take) return;
    cursor = { createdAt: last.createdAt, id: last.id };
  }
}
