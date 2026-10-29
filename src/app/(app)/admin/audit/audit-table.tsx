"use client";

import Link from "next/link";
import { useState } from "react";
import { FilterIcon } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetFooter,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import type { AuditLogRow, PersonRef } from "@/lib/audit-log";

/** A row as the page prepares it: times formatted and links built on the server. */
export interface AuditTableRow {
  row: AuditLogRow;
  time: string;
  actorHref: string | null;
  targetHref: string | null;
}

function shortId(id: string): string {
  return id.slice(0, 8);
}

function personName(person: PersonRef): {
  primary: string;
  secondary: string | null;
} {
  if (person.status === "DELETED") {
    return { primary: "Deleted user", secondary: shortId(person.id) };
  }
  if (person.name === null && person.email === null) {
    return { primary: "Unknown user", secondary: shortId(person.id) };
  }
  return {
    primary: person.name ?? person.email ?? "Unknown user",
    secondary: person.name ? person.email : null,
  };
}

function PersonCell({ person }: { person: PersonRef }) {
  const { primary, secondary } = personName(person);
  return (
    <div className="flex flex-col">
      <span>{primary}</span>
      {secondary ? (
        <span className="text-xs text-muted-foreground">{secondary}</span>
      ) : null}
    </div>
  );
}

function ActorCell({ actor }: { actor: AuditLogRow["actor"] }) {
  if (actor.type === "BREAK_GLASS") {
    return <Badge variant="destructive">Break-glass</Badge>;
  }
  if (actor.type === "SYSTEM" || !actor.user) {
    return <span className="text-muted-foreground">System</span>;
  }
  return <PersonCell person={actor.user} />;
}

function targetText(target: NonNullable<AuditLogRow["target"]>): string {
  if (target.label) return target.label;
  const kind = target.type === "SESSION" ? "Session" : "Transfer";
  return `${kind} ${shortId(target.id)}…`;
}

function TargetCell({ target }: { target: AuditLogRow["target"] }) {
  if (!target) return <span className="text-muted-foreground">—</span>;
  if (target.user) return <PersonCell person={target.user} />;
  return <span>{targetText(target)}</span>;
}

function FilterLink({ href, label }: { href: string; label: string }) {
  return (
    <Link
      href={href}
      aria-label={label}
      title={label}
      className="inline-flex size-6 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
    >
      <FilterIcon className="size-3.5" aria-hidden="true" />
    </Link>
  );
}

function actorSummary(actor: AuditLogRow["actor"]): string {
  if (actor.type === "BREAK_GLASS") return "Break-glass";
  if (actor.type === "SYSTEM" || !actor.user) return "System";
  const { primary, secondary } = personName(actor.user);
  return `${primary}${secondary ? ` (${secondary})` : ""}`;
}

function DetailRow({
  label,
  children,
}: {
  label: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-0.5">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd className="break-words">{children}</dd>
    </div>
  );
}

function EventSheet({
  entry,
  onClose,
}: {
  entry: AuditTableRow | null;
  onClose: () => void;
}) {
  const row = entry?.row;
  const hasMetadata =
    row !== undefined &&
    row.metadata !== null &&
    !(
      typeof row.metadata === "object" &&
      !Array.isArray(row.metadata) &&
      Object.keys(row.metadata).length === 0
    );
  return (
    <Sheet
      open={entry !== null}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetContent className="w-full overflow-y-auto sm:max-w-md">
        {entry && row ? (
          <>
            <SheetHeader>
              <SheetTitle className="font-mono">{row.type}</SheetTitle>
              <SheetDescription>{entry.time}</SheetDescription>
            </SheetHeader>
            <dl className="flex flex-col gap-3 px-4 text-sm">
              <DetailRow label="Event ID">
                <span className="font-mono text-xs">{row.id}</span>
              </DetailRow>
              <DetailRow label="Time (UTC)">
                <span className="font-mono text-xs">{row.createdAt}</span>
              </DetailRow>
              <DetailRow label="Actor">
                <div>{actorSummary(row.actor)}</div>
                <div className="font-mono text-xs text-muted-foreground">
                  {row.actor.type}
                  {row.actor.user ? ` ${row.actor.user.id}` : ""}
                </div>
              </DetailRow>
              <DetailRow label="Target">
                {row.target ? (
                  <>
                    <div>
                      {row.target.user
                        ? actorSummary({ type: "USER", user: row.target.user })
                        : targetText(row.target)}
                    </div>
                    <div className="font-mono text-xs text-muted-foreground">
                      {row.target.type} {row.target.id}
                    </div>
                  </>
                ) : (
                  "—"
                )}
              </DetailRow>
              <DetailRow label="IP">{row.ip ?? "—"}</DetailRow>
              <DetailRow label="User agent">
                <span className="break-all">{row.userAgent ?? "—"}</span>
              </DetailRow>
            </dl>
            <div className="flex flex-col gap-1 px-4 text-sm">
              <h3 className="text-xs text-muted-foreground">Metadata</h3>
              {hasMetadata ? (
                <pre className="overflow-x-auto rounded-lg bg-muted p-3 font-mono text-xs">
                  {JSON.stringify(row.metadata, null, 2)}
                </pre>
              ) : (
                <p className="text-muted-foreground">
                  No metadata for this event.
                </p>
              )}
            </div>
            {entry.actorHref || entry.targetHref ? (
              <SheetFooter>
                {entry.actorHref ? (
                  <Button
                    variant="outline"
                    render={<Link href={entry.actorHref} />}
                  >
                    Filter by actor
                  </Button>
                ) : null}
                {entry.targetHref ? (
                  <Button
                    variant="outline"
                    render={<Link href={entry.targetHref} />}
                  >
                    Filter by target
                  </Button>
                ) : null}
              </SheetFooter>
            ) : null}
          </>
        ) : null}
      </SheetContent>
    </Sheet>
  );
}

export function AuditTable({ rows }: { rows: AuditTableRow[] }) {
  const [selected, setSelected] = useState<AuditTableRow | null>(null);
  return (
    <>
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>Time</TableHead>
            <TableHead>Event</TableHead>
            <TableHead>Actor</TableHead>
            <TableHead>Target</TableHead>
            <TableHead>IP</TableHead>
            <TableHead>
              <span className="sr-only">Actions</span>
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((entry) => {
            const { row } = entry;
            return (
              <TableRow key={row.id}>
                <TableCell className="whitespace-nowrap">
                  {entry.time}
                </TableCell>
                <TableCell>
                  <Badge variant="outline" className="font-mono">
                    {row.type}
                  </Badge>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <ActorCell actor={row.actor} />
                    {entry.actorHref ? (
                      <FilterLink
                        href={entry.actorHref}
                        label="Filter by this user"
                      />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <TargetCell target={row.target} />
                    {entry.targetHref ? (
                      <FilterLink
                        href={entry.targetHref}
                        label="Filter by this user"
                      />
                    ) : null}
                  </div>
                </TableCell>
                <TableCell className="font-mono text-xs">
                  {row.ip ?? "—"}
                </TableCell>
                <TableCell>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`Details for ${row.type} at ${entry.time}`}
                    onClick={() => setSelected(entry)}
                  >
                    Details
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
      <EventSheet entry={selected} onClose={() => setSelected(null)} />
    </>
  );
}
