import type { Metadata } from "next";
import Link from "next/link";
import { z } from "zod";
import { buttonVariants } from "@/components/ui/button";
import {
  AUDIT_EXPORT_CAP,
  AUDIT_TIME_ZONE,
  auditLogPageSchema,
  buildAuditWhere,
  countAuditEvents,
  listAuditEvents,
  resolveUserFilter,
  serializeAuditFilter,
  type AuditLogFilter,
  type AuditLogRow,
} from "@/lib/audit-log";
import { requireAdmin } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";
import { cn } from "@/lib/utils";
import {
  AuditFilters,
  type AuditFieldErrors,
  type AuditFilterValues,
} from "./audit-filters";
import { AuditTable, type AuditTableRow } from "./audit-table";

export const metadata: Metadata = { title: "Audit log" };

const PATH = "/admin/audit";
const EXPORT_PATH = "/api/sgauth/admin/audit/export";

type RawSearchParams = Record<string, string | string[] | undefined>;

const timeFormat = new Intl.DateTimeFormat("en-US", {
  timeZone: AUDIT_TIME_ZONE,
  dateStyle: "medium",
  timeStyle: "short",
});

function first(value: string | string[] | undefined): string {
  return (Array.isArray(value) ? value[0] : value) ?? "";
}

function formValues(raw: RawSearchParams): AuditFilterValues {
  const type = raw.type === undefined ? [] : [raw.type].flat();
  return {
    type: type.filter((entry) => entry !== ""),
    user: first(raw.user),
    userRole: first(raw.userRole) || "any",
    actorType: first(raw.actorType),
    targetType: first(raw.targetType),
    targetId: first(raw.targetId),
    from: first(raw.from),
    to: first(raw.to),
  };
}

function href(path: string, params: URLSearchParams): string {
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

function userHref(filter: AuditLogFilter, userId: string): string {
  return href(
    PATH,
    serializeAuditFilter({ ...filter, user: userId, userRole: "any" }),
  );
}

function toTableRow(row: AuditLogRow, filter: AuditLogFilter): AuditTableRow {
  return {
    row,
    time: timeFormat.format(new Date(row.createdAt)),
    actorHref: row.actor.user ? userHref(filter, row.actor.user.id) : null,
    targetHref: row.target?.user ? userHref(filter, row.target.user.id) : null,
  };
}

function Heading() {
  return (
    <div className="flex flex-col gap-1">
      <h1 className="text-2xl font-semibold tracking-tight">Audit log</h1>
      <p className="text-muted-foreground">
        Every security-relevant action in SGAuth. Times are Eastern.
      </p>
    </div>
  );
}

function summary(count: number, filtered: boolean): string {
  if (count > AUDIT_EXPORT_CAP) {
    return filtered
      ? `More than ${AUDIT_EXPORT_CAP.toLocaleString("en-US")} matching events`
      : `More than ${AUDIT_EXPORT_CAP.toLocaleString("en-US")} events`;
  }
  const noun = count === 1 ? "event" : "events";
  return filtered
    ? `${count.toLocaleString("en-US")} matching ${noun}`
    : `${count.toLocaleString("en-US")} ${noun}`;
}

export default async function AuditLogPage({
  searchParams,
}: {
  searchParams: Promise<RawSearchParams>;
}) {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(PATH);
  const raw = await searchParams;
  const values = formValues(raw);

  const parsed = auditLogPageSchema.safeParse(raw);
  if (!parsed.success) {
    const flat = z.flattenError(parsed.error).fieldErrors as Record<
      string,
      string[] | undefined
    >;
    const errors: AuditFieldErrors = {};
    for (const key of [
      "type",
      "user",
      "targetType",
      "targetId",
      "from",
      "to",
    ] as const) {
      const message = flat[key]?.[0];
      if (message) errors[key] = message;
    }
    return (
      <div className="flex flex-col gap-6">
        <Heading />
        <AuditFilters values={values} errors={errors} />
        <p role="alert" className="text-sm text-destructive">
          Some filters are invalid. Fix them and apply again.
        </p>
      </div>
    );
  }

  const { cursor, ...filter } = parsed.data;
  const filtered = serializeAuditFilter(filter).size > 0;

  const user = filter.user
    ? await resolveUserFilter(prisma, filter.user)
    : undefined;
  const where = buildAuditWhere(filter, user?.id ?? null);
  const unknownEmail = filter.user !== undefined && user === null;

  const [{ events, nextCursor }, count] = await Promise.all([
    listAuditEvents(prisma, where, cursor ?? undefined),
    countAuditEvents(prisma, where),
  ]);

  const filterParams = serializeAuditFilter(filter);
  const exportHref = href(EXPORT_PATH, filterParams);
  const newestHref = href(PATH, filterParams);
  const olderHref = nextCursor
    ? href(PATH, new URLSearchParams([...filterParams, ["cursor", nextCursor]]))
    : null;
  const rows = events.map((event) => toTableRow(event, filter));
  const empty = events.length === 0;

  return (
    <div className="flex flex-col gap-6">
      <Heading />
      <AuditFilters
        values={values}
        errors={{}}
        userNote={
          unknownEmail
            ? `No user has the email ${filter.user}. Showing no events.`
            : undefined
        }
      />
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-col">
          <p className="text-sm font-medium">{summary(count, filtered)}</p>
          {count > AUDIT_EXPORT_CAP ? (
            <p className="text-xs text-muted-foreground">
              Export includes the newest{" "}
              {AUDIT_EXPORT_CAP.toLocaleString("en-US")}.
            </p>
          ) : null}
        </div>
        {empty && !cursor ? (
          <button
            type="button"
            disabled
            title="Nothing to export"
            className={buttonVariants({ variant: "outline" })}
          >
            Export CSV
          </button>
        ) : (
          <a
            href={exportHref}
            download
            className={buttonVariants({ variant: "outline" })}
          >
            Export CSV
          </a>
        )}
      </div>
      {empty ? (
        <div className="flex flex-col items-start gap-2 text-muted-foreground">
          <p>
            {filtered
              ? "No events match these filters."
              : "No audit events yet."}
          </p>
          {filtered ? (
            <Link
              href={PATH}
              className={buttonVariants({ variant: "outline" })}
            >
              Clear filters
            </Link>
          ) : null}
        </div>
      ) : (
        <AuditTable rows={rows} />
      )}
      {cursor || olderHref ? (
        <nav
          aria-label="Pagination"
          className={cn("flex items-center gap-4 text-sm")}
        >
          {cursor ? (
            <Link
              href={newestHref}
              className="underline-offset-4 hover:underline"
            >
              ← Back to newest
            </Link>
          ) : null}
          {olderHref ? (
            <Link
              href={olderHref}
              className="underline-offset-4 hover:underline"
            >
              Older events →
            </Link>
          ) : null}
        </nav>
      ) : null}
    </div>
  );
}
