import { Badge } from "@/components/ui/badge";
import type { OrgChartPosition } from "@/lib/org-chart";
import type { OrgTreeNode } from "@/lib/position-org";

export function OrgChartCard({ position }: { position: OrgChartPosition }) {
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border bg-card px-3 py-2 text-card-foreground">
      <span className="font-medium">{position.name}</span>
      {position.category ? (
        <span className="text-sm text-muted-foreground">
          {position.category}
        </span>
      ) : null}
      {position.isLeadership ? (
        <Badge variant="secondary">Leadership</Badge>
      ) : null}
    </div>
  );
}

function OrgBranch({ entry }: { entry: OrgTreeNode<OrgChartPosition> }) {
  return (
    <li className="flex flex-col gap-2">
      <OrgChartCard position={entry.node} />
      {entry.reports.length > 0 ? (
        <ul className="ml-3 flex flex-col gap-2 border-l pl-4 sm:ml-5 sm:pl-6">
          {entry.reports.map((report) => (
            <OrgBranch key={report.node.id} entry={report} />
          ))}
        </ul>
      ) : null}
    </li>
  );
}

/** A nested list: each position's reports sit indented beneath it. */
export function OrgTree({
  roots,
}: {
  roots: readonly OrgTreeNode<OrgChartPosition>[];
}) {
  return (
    <ul className="flex flex-col gap-3">
      {roots.map((entry) => (
        <OrgBranch key={entry.node.id} entry={entry} />
      ))}
    </ul>
  );
}
