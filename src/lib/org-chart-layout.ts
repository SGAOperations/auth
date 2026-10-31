// Pure layout for the org chart canvas. Client-safe: no database, no
// server-only. Turns the nested `buildOrgTree` output into node coordinates,
// elbow edges and the keyboard neighbour map.

import type { ManagerNode, OrgTreeNode } from "@/lib/position-org";

export type ChartSizes = {
  nodeWidth: number;
  nodeHeight: number;
  gapX: number;
  gapY: number;
};

export const DEFAULT_SIZES: ChartSizes = {
  nodeWidth: 200,
  nodeHeight: 88,
  gapX: 24,
  gapY: 56,
};

export type LayoutNode = {
  id: string;
  /** Left edge. */
  x: number;
  /** Top edge. */
  y: number;
  depth: number;
  parentId: string | null;
};

export type LayoutEdge = { fromId: string; toId: string };

export type OrgChartLayout = {
  /** Depth-first order, siblings in input order. */
  nodes: LayoutNode[];
  edges: LayoutEdge[];
  width: number;
  height: number;
};

type Frame = { entry: OrgTreeNode<ManagerNode>; placed: Placed; next: number };
type Placed = LayoutNode & { children: Placed[] };

/**
 * Each leaf takes one slot left to right; a parent is centred over its
 * children; roots sit side by side as a forest. Iterative, so a deep chain
 * cannot overflow the stack.
 */
export function layoutOrgChart(
  roots: readonly OrgTreeNode<ManagerNode>[],
  sizes: ChartSizes = DEFAULT_SIZES,
): OrgChartLayout {
  const slot = sizes.nodeWidth + sizes.gapX;
  const rowHeight = sizes.nodeHeight + sizes.gapY;
  const nodes: LayoutNode[] = [];
  const edges: LayoutEdge[] = [];
  let cursor = 0;
  let maxDepth = -1;

  const place = (
    entry: OrgTreeNode<ManagerNode>,
    depth: number,
    parent: Placed | null,
  ): Frame => {
    const placed: Placed = {
      id: entry.node.id,
      x: 0,
      y: depth * rowHeight,
      depth,
      parentId: parent ? parent.id : null,
      children: [],
    };
    parent?.children.push(placed);
    if (parent) edges.push({ fromId: parent.id, toId: placed.id });
    nodes.push(placed);
    maxDepth = Math.max(maxDepth, depth);
    return { entry, placed, next: 0 };
  };

  for (const root of roots) {
    const stack: Frame[] = [place(root, 0, null)];
    while (stack.length > 0) {
      const frame = stack[stack.length - 1];
      const report = frame.entry.reports[frame.next];
      if (report !== undefined) {
        frame.next += 1;
        stack.push(place(report, frame.placed.depth + 1, frame.placed));
        continue;
      }
      const { children } = frame.placed;
      if (children.length === 0) {
        frame.placed.x = cursor * slot;
        cursor += 1;
      } else {
        frame.placed.x = (children[0].x + children[children.length - 1].x) / 2;
      }
      stack.pop();
    }
  }

  return {
    nodes: nodes.map(({ id, x, y, depth, parentId }) => ({
      id,
      x,
      y,
      depth,
      parentId,
    })),
    edges,
    width: cursor === 0 ? 0 : cursor * slot - sizes.gapX,
    height: maxDepth < 0 ? 0 : maxDepth * rowHeight + sizes.nodeHeight,
  };
}

/** An elbow from the parent's bottom centre to the child's top centre. */
export function edgePath(
  parent: Pick<LayoutNode, "x" | "y">,
  child: Pick<LayoutNode, "x" | "y">,
  sizes: ChartSizes = DEFAULT_SIZES,
): string {
  const startX = parent.x + sizes.nodeWidth / 2;
  const startY = parent.y + sizes.nodeHeight;
  const endX = child.x + sizes.nodeWidth / 2;
  const midY = startY + (child.y - startY) / 2;
  return `M ${startX} ${startY} V ${midY} H ${endX} V ${child.y}`;
}

export type Neighbours = {
  parent: string | null;
  firstChild: string | null;
  prev: string | null;
  next: string | null;
  /** 1-based place among siblings, and how many siblings. */
  position: number;
  setSize: number;
  /** 1-based tree level. */
  level: number;
};

export type FocusMap = {
  /** Depth-first, the order for the DOM. */
  ids: string[];
  neighbours: Record<string, Neighbours>;
  firstRoot: string | null;
  lastRoot: string | null;
};

export function focusNeighbours(layout: OrgChartLayout): FocusMap {
  const siblings = new Map<string | null, string[]>();
  for (const node of layout.nodes) {
    const group = siblings.get(node.parentId) ?? [];
    group.push(node.id);
    siblings.set(node.parentId, group);
  }

  const neighbours: Record<string, Neighbours> = {};
  for (const node of layout.nodes) {
    const group = siblings.get(node.parentId) ?? [];
    const index = group.indexOf(node.id);
    neighbours[node.id] = {
      parent: node.parentId,
      firstChild: siblings.get(node.id)?.[0] ?? null,
      prev: group[index - 1] ?? null,
      next: group[index + 1] ?? null,
      position: index + 1,
      setSize: group.length,
      level: node.depth + 1,
    };
  }

  const rootIds = siblings.get(null) ?? [];
  return {
    ids: layout.nodes.map((node) => node.id),
    neighbours,
    firstRoot: rootIds[0] ?? null,
    lastRoot: rootIds[rootIds.length - 1] ?? null,
  };
}
