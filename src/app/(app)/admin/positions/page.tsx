import type { Metadata } from "next";
import { requireAdmin } from "@/lib/auth/guards";
import { listPositions } from "@/lib/positions";
import { CreatePositionDialog } from "./_components/create-position-dialog";
import { PositionsList } from "./_components/positions-list";
import { PositionsTabs } from "./_components/positions-tabs";

export const metadata: Metadata = { title: "Positions" };

const PATH = "/admin/positions";

export default async function PositionsPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(PATH);

  const all = await listPositions({ includeDeleted: true });
  const active = all.filter((position) => position.deletedAt === null);
  const deletedCount = all.length - active.length;
  const categories = [
    ...new Set(
      active.flatMap((position) =>
        position.category ? [position.category] : [],
      ),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="flex flex-col gap-1">
          <h1 className="text-2xl font-semibold tracking-tight">Positions</h1>
          <p className="text-muted-foreground">
            Products check a position&apos;s key to grant access. You can rename
            a position at any time; its key never changes.
          </p>
        </div>
        <CreatePositionDialog categories={categories} />
      </div>

      <PositionsTabs
        current="active"
        activeCount={active.length}
        deletedCount={deletedCount}
      />

      {active.length === 0 ? (
        <div className="flex flex-col items-start gap-3 text-muted-foreground">
          <p>No positions yet.</p>
          <CreatePositionDialog categories={categories} />
        </div>
      ) : (
        <PositionsList
          positions={active.map((position) => ({
            id: position.id,
            key: position.key,
            name: position.name,
            category: position.category,
            holderCount: position.holderCount,
          }))}
        />
      )}
    </div>
  );
}
