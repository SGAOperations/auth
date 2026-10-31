import "server-only";
import { buildOrgTree, type OrgTreeNode } from "@/lib/position-org";
import { loadPositionGraph } from "@/lib/positions";

/** What the org chart shows. No key, description, holders or counts. */
export type OrgChartPosition = {
  id: string;
  name: string;
  category: string | null;
  isLeadership: boolean;
  managerPositionId: string | null;
};

export type OrgChart = {
  roots: OrgTreeNode<OrgChartPosition>[];
  unlinked: OrgChartPosition[];
  total: number;
};

/**
 * The active positions nested under their managers, projected to the safe
 * fields. Read-only; reads are not audited.
 */
export async function loadOrgChart(
  options: Parameters<typeof loadPositionGraph>[0] = {},
): Promise<OrgChart> {
  const graph = await loadPositionGraph(options);
  const positions = graph.map(
    ({ id, name, category, isLeadership, managerPositionId }) => ({
      id,
      name,
      category,
      isLeadership,
      managerPositionId,
    }),
  );
  return { ...buildOrgTree(positions), total: positions.length };
}
