"use client";

import { MoreHorizontalIcon } from "lucide-react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { groupPositionsByCategory } from "@/lib/position-view";
import {
  DeletePositionDialog,
  type DeletablePosition,
} from "./delete-position-dialog";

export interface PositionListRow {
  id: string;
  key: string;
  name: string;
  category: string | null;
  holderCount: number;
  isLeadership: boolean;
  /** The active manager's name, or null for no manager. */
  managerName: string | null;
}

export function PositionsList({
  positions,
}: {
  positions: readonly PositionListRow[];
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [deleting, setDeleting] = useState<DeletablePosition | null>(null);

  const needle = query.trim().toLowerCase();
  const matches = positions.filter(
    (position) =>
      needle === "" ||
      position.name.toLowerCase().includes(needle) ||
      position.key.includes(needle),
  );
  const groups = groupPositionsByCategory(matches);

  return (
    <div className="flex flex-col gap-6">
      <Input
        type="search"
        value={query}
        onChange={(event) => setQuery(event.target.value)}
        placeholder="Filter by name or key"
        aria-label="Filter by name or key"
        className="max-w-sm"
      />

      {groups.length === 0 ? (
        <p className="text-muted-foreground">
          No positions match &quot;{query.trim()}&quot;.
        </p>
      ) : (
        groups.map((group) => (
          <section key={group.category} className="flex flex-col gap-2">
            <h2 className="text-base font-semibold">
              {group.category}{" "}
              <span className="font-normal text-muted-foreground">
                ({group.positions.length})
              </span>
            </h2>
            <div className="overflow-x-auto">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Name</TableHead>
                    <TableHead>Key</TableHead>
                    <TableHead>Reports to</TableHead>
                    <TableHead>Holders</TableHead>
                    <TableHead className="w-12">
                      <span className="sr-only">Actions</span>
                    </TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {group.positions.map((position) => (
                    <TableRow key={position.id}>
                      <TableCell>
                        <div className="flex flex-wrap items-center gap-2">
                          <Link
                            href={`/admin/positions/${position.id}`}
                            className="font-medium underline-offset-4 hover:underline"
                          >
                            {position.name}
                          </Link>
                          {position.isLeadership ? (
                            <Badge variant="secondary">Leadership</Badge>
                          ) : null}
                        </div>
                      </TableCell>
                      <TableCell className="font-mono text-xs">
                        {position.key}
                      </TableCell>
                      <TableCell>{position.managerName ?? "—"}</TableCell>
                      <TableCell aria-label={`${position.holderCount} holders`}>
                        {position.holderCount}
                      </TableCell>
                      <TableCell>
                        <DropdownMenu>
                          <DropdownMenuTrigger
                            render={
                              <Button
                                variant="ghost"
                                size="icon"
                                aria-label={`Actions for ${position.name}`}
                              />
                            }
                          >
                            <MoreHorizontalIcon aria-hidden="true" />
                          </DropdownMenuTrigger>
                          <DropdownMenuContent align="end">
                            <DropdownMenuItem
                              onClick={() =>
                                router.push(`/admin/positions/${position.id}`)
                              }
                            >
                              Edit
                            </DropdownMenuItem>
                            <DropdownMenuItem
                              variant="destructive"
                              onClick={() =>
                                setDeleting({
                                  id: position.id,
                                  key: position.key,
                                  name: position.name,
                                })
                              }
                            >
                              Delete
                            </DropdownMenuItem>
                          </DropdownMenuContent>
                        </DropdownMenu>
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
          </section>
        ))
      )}

      <DeletePositionDialog
        position={deleting}
        onOpenChange={(open) => {
          if (!open) setDeleting(null);
        }}
        onDeleted={() => router.refresh()}
        onStale={() => router.refresh()}
      />
    </div>
  );
}
