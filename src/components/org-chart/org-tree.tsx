import { Badge } from "@/components/ui/badge";
import type { OrgChartPosition } from "@/lib/org-chart";

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
