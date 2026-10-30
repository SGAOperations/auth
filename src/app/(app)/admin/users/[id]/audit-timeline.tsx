import Link from "next/link";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { auditDetail, auditLabel } from "@/lib/admin/audit-labels";
import { formatDateTime, formatRelative } from "@/lib/admin/format";
import type { UserTimeline } from "@/lib/admin/user-detail-queries";
import type { AuditLogRow } from "@/lib/audit-log";
import { displayName } from "@/lib/user-display";

function actorName(actor: AuditLogRow["actor"]): string {
  if (actor.type === "BREAK_GLASS") return "Break-glass";
  const user = actor.user;
  if (actor.type === "SYSTEM" || !user) return "System";
  if (user.status === "DELETED") return "Deleted user";
  if (user.name === null && user.email === null) return "Unknown user";
  return displayName({ name: user.name ?? user.email ?? "Unknown user" });
}

/** The position behind a position event, by the id its metadata carries. */
function positionIdOf(row: AuditLogRow): string | null {
  const metadata = row.metadata;
  if (typeof metadata !== "object" || metadata === null) return null;
  if (Array.isArray(metadata)) return null;
  return typeof metadata.positionId === "string" ? metadata.positionId : null;
}

export function AuditTimeline({
  timeline,
  positionNames,
  basePath,
  now,
  isFirstPage,
}: {
  timeline: UserTimeline;
  /** Position id to "Name (key)", for the position events on this page. */
  positionNames: ReadonlyMap<string, string>;
  basePath: string;
  now: Date;
  isFirstPage: boolean;
}) {
  const { events, nextCursor } = timeline;
  return (
    <Card>
      <CardHeader>
        <CardTitle>Activity</CardTitle>
        <CardDescription>
          What this account did and what was done to it, newest first. Times are
          Eastern.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {events.length === 0 ? (
          <p className="text-sm text-muted-foreground">
            No activity recorded yet.
          </p>
        ) : (
          <ol className="flex flex-col divide-y">
            {events.map((row) => {
              const positionId = positionIdOf(row);
              const detail = auditDetail(
                row.type,
                row.metadata,
                positionId ? positionNames.get(positionId) : null,
              );
              return (
                <li key={row.id} className="flex flex-col gap-0.5 py-2 text-sm">
                  <p>
                    <span className="font-medium">{auditLabel(row.type)}</span>
                    <span className="text-muted-foreground">
                      {" · by "}
                      {actorName(row.actor)}
                      {" · "}
                    </span>
                    <time
                      dateTime={row.createdAt}
                      title={formatDateTime(row.createdAt)}
                      className="text-muted-foreground"
                    >
                      {formatRelative(row.createdAt, now)}
                    </time>
                  </p>
                  {detail ? (
                    <p className="text-xs text-muted-foreground">{detail}</p>
                  ) : null}
                </li>
              );
            })}
          </ol>
        )}
        {nextCursor || !isFirstPage ? (
          <nav aria-label="Activity pages" className="flex gap-4 text-sm">
            {!isFirstPage ? (
              <Link
                href={basePath}
                className="underline-offset-4 hover:underline"
              >
                ← Back to newest
              </Link>
            ) : null}
            {nextCursor ? (
              <Link
                href={`${basePath}?auditCursor=${encodeURIComponent(nextCursor)}`}
                className="underline-offset-4 hover:underline"
              >
                Older events →
              </Link>
            ) : null}
          </nav>
        ) : null}
      </CardContent>
    </Card>
  );
}
