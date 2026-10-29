import type { Metadata } from "next";
import Link from "next/link";
import { notFound } from "next/navigation";
import { requireAdmin } from "@/lib/auth/guards";
import { keyReusableOn } from "@/lib/position-key";
import { formatPositionDate } from "@/lib/position-view";
import { getPositionSummary, listPositions } from "@/lib/positions";
import { EditPositionForm } from "../_components/edit-position-form";

export const metadata: Metadata = { title: "Position" };

function ReadOnlyField({
  label,
  value,
  mono = false,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div className="flex flex-col gap-1">
      <dt className="text-sm font-medium">{label}</dt>
      <dd
        className={
          mono ? "font-mono text-sm break-all" : "text-sm whitespace-pre-wrap"
        }
      >
        {value}
      </dd>
    </div>
  );
}

export default async function PositionPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  const { id } = await params;
  // The layout is skipped on soft navigation, so the page checks again.
  await requireAdmin(`/admin/positions/${encodeURIComponent(id)}`);

  const position = await getPositionSummary(id);
  if (!position) notFound();

  const back = (
    <Link
      href="/admin/positions"
      className="text-sm text-muted-foreground underline-offset-4 hover:underline"
    >
      ← All positions
    </Link>
  );

  if (position.deletedAt) {
    return (
      <div className="flex max-w-2xl flex-col gap-6">
        <div className="flex flex-col gap-1">
          {back}
          <h1 className="text-2xl font-semibold tracking-tight">
            {position.name}
          </h1>
        </div>
        <p role="status" className="rounded-lg border bg-muted/50 p-4 text-sm">
          Deleted on {formatPositionDate(position.deletedAt)}. The key{" "}
          <code className="font-mono">{position.key}</code> can&apos;t be reused
          until {formatPositionDate(keyReusableOn(position.deletedAt))}.{" "}
          {position.holderCount === 1
            ? "1 person held"
            : `${position.holderCount} people held`}{" "}
          it when it was deleted.
        </p>
        <dl className="flex flex-col gap-4">
          <ReadOnlyField label="Name" value={position.name} />
          <ReadOnlyField label="Key" value={position.key} mono />
          <ReadOnlyField label="Category" value={position.category ?? "—"} />
          <ReadOnlyField
            label="Description"
            value={position.description ?? "—"}
          />
        </dl>
      </div>
    );
  }

  const all = await listPositions();
  const categories = [
    ...new Set(
      all.flatMap((entry) => (entry.category ? [entry.category] : [])),
    ),
  ].sort((a, b) => a.localeCompare(b));

  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        {back}
        <h1 className="text-2xl font-semibold tracking-tight">
          {position.name}
        </h1>
      </div>
      <EditPositionForm
        position={{
          id: position.id,
          key: position.key,
          name: position.name,
          category: position.category,
          description: position.description,
        }}
        categories={categories}
      />
    </div>
  );
}
