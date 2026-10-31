import type { Metadata } from "next";
import Link from "next/link";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { requireAdmin } from "@/lib/auth/guards";
import { keyReusableOn } from "@/lib/position-key";
import { formatPositionDate } from "@/lib/position-view";
import { listPositions } from "@/lib/positions";
import { PositionsTabs } from "../_components/positions-tabs";

export const metadata: Metadata = { title: "Deleted positions" };

const PATH = "/admin/positions/deleted";

export default async function DeletedPositionsPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(PATH);

  const all = await listPositions({ includeDeleted: true });
  const deleted = all.flatMap((position) =>
    position.deletedAt ? [{ ...position, deletedAt: position.deletedAt }] : [],
  );
  deleted.sort((a, b) => b.deletedAt.getTime() - a.deletedAt.getTime());

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
        <p className="text-muted-foreground">
          Products check a position&apos;s key to grant access. You can rename a
          position at any time; its key never changes.
        </p>
      </div>

      <PositionsTabs
        current="deleted"
        activeCount={all.length - deleted.length}
        deletedCount={deleted.length}
      />

      {deleted.length === 0 ? (
        <p className="text-muted-foreground">No deleted positions.</p>
      ) : (
        <div className="overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Name</TableHead>
                <TableHead>Key</TableHead>
                <TableHead>Category</TableHead>
                <TableHead>Deleted on</TableHead>
                <TableHead>Key reusable on</TableHead>
                <TableHead>Former holders</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {deleted.map((position) => (
                <TableRow key={position.id}>
                  <TableCell>
                    <Link
                      href={`/admin/positions/${position.id}`}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {position.name}
                    </Link>
                  </TableCell>
                  <TableCell className="font-mono text-xs">
                    {position.key}
                  </TableCell>
                  <TableCell>{position.category ?? "—"}</TableCell>
                  <TableCell>
                    {formatPositionDate(position.deletedAt)}
                  </TableCell>
                  <TableCell>
                    {formatPositionDate(keyReusableOn(position.deletedAt))}
                  </TableCell>
                  <TableCell>{position.holderCount}</TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}
    </div>
  );
}
