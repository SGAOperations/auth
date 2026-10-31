import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { OrgChartCanvas } from "@/components/org-chart/org-chart-canvas";
import { OrgChartCard } from "@/components/org-chart/org-tree";
import {
  Empty,
  EmptyDescription,
  EmptyHeader,
  EmptyTitle,
} from "@/components/ui/empty";
import { requireUser } from "@/lib/auth/guards";
import { canViewOrgChart } from "@/lib/authz";
import { loadOrgChart } from "@/lib/org-chart";

export const metadata: Metadata = { title: "Org Chart" };

export default async function OrgChartPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  const user = await requireUser("/org-chart");
  if (!canViewOrgChart(user).allowed) notFound();

  const { roots, unlinked, total } = await loadOrgChart();

  return (
    <div className="mx-auto flex w-full max-w-5xl flex-col gap-6">
      <header className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Org Chart</h1>
        <p className="text-muted-foreground">
          How SGA positions report to each other.
        </p>
      </header>

      {total === 0 ? (
        <Empty className="border">
          <EmptyHeader>
            <EmptyTitle>No positions yet</EmptyTitle>
            <EmptyDescription>
              Positions will appear here once an admin creates them.
            </EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <>
          {roots.length > 0 ? (
            <OrgChartCanvas roots={roots} />
          ) : (
            <p className="text-muted-foreground">
              No reporting lines have been set yet.
            </p>
          )}

          {unlinked.length > 0 ? (
            <section className="flex flex-col gap-3">
              <h2 className="font-heading text-base leading-snug font-medium">
                Not yet placed in the chart
              </h2>
              <ul className="flex flex-col gap-2">
                {unlinked.map((position) => (
                  <li key={position.id}>
                    <OrgChartCard position={position} />
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
        </>
      )}
    </div>
  );
}
