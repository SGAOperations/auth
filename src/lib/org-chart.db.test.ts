import { describe, expect, it } from "vitest";
import { loadOrgChart, type OrgChartPosition } from "@/lib/org-chart";
import type { OrgTreeNode } from "@/lib/position-org";
import { createPosition } from "@/test/factories";

function find(
  trees: readonly OrgTreeNode<OrgChartPosition>[],
  id: string,
): OrgTreeNode<OrgChartPosition> | undefined {
  for (const tree of trees) {
    if (tree.node.id === id) return tree;
    const nested = find(tree.reports, id);
    if (nested) return nested;
  }
  return undefined;
}

function everyNode(
  chart: Awaited<ReturnType<typeof loadOrgChart>>,
): OrgChartPosition[] {
  const nodes: OrgChartPosition[] = [...chart.unlinked];
  const walk = (trees: readonly OrgTreeNode<OrgChartPosition>[]) => {
    for (const tree of trees) {
      nodes.push(tree.node);
      walk(tree.reports);
    }
  };
  walk(chart.roots);
  return nodes;
}

describe("loadOrgChart", () => {
  it("nests active reports under their manager and leaves out deleted ones", async () => {
    const manager = await createPosition({ isLeadership: true });
    const first = await createPosition({ managerPositionId: manager.id });
    const second = await createPosition({ managerPositionId: manager.id });
    const removed = await createPosition({
      managerPositionId: manager.id,
      deletedAt: new Date(),
    });

    const chart = await loadOrgChart();
    const tree = find(chart.roots, manager.id);

    expect(tree?.node.isLeadership).toBe(true);
    expect(tree?.reports.map((entry) => entry.node.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    expect(find(chart.roots, removed.id)).toBeUndefined();
    expect(chart.unlinked.some((node) => node.id === removed.id)).toBe(false);
  });

  it("returns only the safe fields", async () => {
    const manager = await createPosition({ description: "internal notes" });
    await createPosition({ managerPositionId: manager.id });

    const chart = await loadOrgChart();
    const nodes = everyNode(chart);

    expect(nodes.length).toBe(chart.total);
    for (const node of nodes) {
      expect(Object.keys(node).sort()).toEqual([
        "category",
        "id",
        "isLeadership",
        "managerPositionId",
        "name",
      ]);
    }
  });
});
