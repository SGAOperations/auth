import { describe, expect, it } from "vitest";
import {
  DEFAULT_SIZES,
  edgePath,
  focusNeighbours,
  layoutOrgChart,
} from "@/lib/org-chart-layout";
import type { ManagerNode, OrgTreeNode } from "@/lib/position-org";

type Spec = [string, Spec[]?];

function tree(spec: Spec): OrgTreeNode<ManagerNode> {
  return {
    node: { id: spec[0], managerPositionId: null },
    reports: (spec[1] ?? []).map(tree),
  };
}

const { nodeWidth, nodeHeight, gapX, gapY } = DEFAULT_SIZES;
const slot = nodeWidth + gapX;
const row = nodeHeight + gapY;

function at(layout: ReturnType<typeof layoutOrgChart>, id: string) {
  const found = layout.nodes.find((node) => node.id === id);
  if (!found) throw new Error(`missing ${id}`);
  return found;
}

describe("layoutOrgChart", () => {
  it("returns an empty layout for no roots", () => {
    expect(layoutOrgChart([])).toEqual({
      nodes: [],
      edges: [],
      width: 0,
      height: 0,
    });
  });

  it("places a single root at the origin", () => {
    const layout = layoutOrgChart([tree(["a"])]);
    expect(layout.nodes).toEqual([
      { id: "a", x: 0, y: 0, depth: 0, parentId: null },
    ]);
    expect(layout.width).toBe(nodeWidth);
    expect(layout.height).toBe(nodeHeight);
  });

  it("stacks a chain one row per level", () => {
    const layout = layoutOrgChart([tree(["a", [["b", [["c"]]]]])]);
    expect(layout.nodes.map((node) => [node.id, node.x, node.y])).toEqual([
      ["a", 0, 0],
      ["b", 0, row],
      ["c", 0, 2 * row],
    ]);
    expect(layout.edges).toEqual([
      { fromId: "a", toId: "b" },
      { fromId: "b", toId: "c" },
    ]);
    expect(layout.height).toBe(2 * row + nodeHeight);
  });

  it("centres a parent over its children", () => {
    const layout = layoutOrgChart([tree(["p", [["a"], ["b"], ["c"]]])]);
    expect(at(layout, "a").x).toBe(0);
    expect(at(layout, "c").x).toBe(2 * slot);
    expect(at(layout, "p").x).toBe(slot);
    expect(layout.width).toBe(3 * slot - gapX);
  });

  it("lays out two roots side by side without overlap", () => {
    const layout = layoutOrgChart([
      tree(["r1", [["a"], ["b"]]]),
      tree(["r2", [["c"]]]),
    ]);
    expect(at(layout, "r1").x).toBe(slot / 2);
    expect(at(layout, "c").x).toBe(2 * slot);
    expect(at(layout, "r2").x).toBe(2 * slot);
    for (const depth of [0, 1]) {
      const xs = layout.nodes
        .filter((node) => node.depth === depth)
        .map((node) => node.x)
        .sort((a, b) => a - b);
      for (let i = 1; i < xs.length; i++) {
        expect(xs[i] - xs[i - 1]).toBeGreaterThanOrEqual(slot);
      }
    }
  });

  it("places every id once and keeps sibling order", () => {
    const layout = layoutOrgChart([
      tree(["p", [["z"], ["m", [["q"]]], ["a"]]]),
    ]);
    const ids = layout.nodes.map((node) => node.id);
    expect(ids).toEqual(["p", "z", "m", "q", "a"]);
    expect(new Set(ids).size).toBe(ids.length);
    expect(at(layout, "z").x).toBeLessThan(at(layout, "m").x);
    expect(at(layout, "m").x).toBeLessThan(at(layout, "a").x);
  });

  it("handles a deep chain without overflowing the stack", () => {
    let root = tree(["n0"]);
    for (let i = 1; i < 5000; i++) {
      root = {
        node: { id: `n${i}`, managerPositionId: null },
        reports: [root],
      };
    }
    const layout = layoutOrgChart([root]);
    expect(layout.nodes).toHaveLength(5000);
    expect(layout.height).toBe(4999 * row + nodeHeight);
  });
});

describe("edgePath", () => {
  it("runs down, across, then down between the card edges", () => {
    const parent = { x: 100, y: 0 };
    const child = { x: 300, y: row };
    const path = edgePath(parent, child);
    const startY = nodeHeight;
    const midY = startY + (row - startY) / 2;
    expect(path).toBe(
      `M ${100 + nodeWidth / 2} ${startY} V ${midY} H ${300 + nodeWidth / 2} V ${row}`,
    );
  });
});

describe("focusNeighbours", () => {
  const layout = layoutOrgChart([
    tree(["r1", [["a", [["a1"]]], ["b"]]]),
    tree(["r2", [["c"]]]),
  ]);
  const focus = focusNeighbours(layout);

  it("lists ids depth first", () => {
    expect(focus.ids).toEqual(["r1", "a", "a1", "b", "r2", "c"]);
  });

  it("links parent, first child and siblings", () => {
    expect(focus.neighbours.a).toMatchObject({
      parent: "r1",
      firstChild: "a1",
      prev: null,
      next: "b",
      position: 1,
      setSize: 2,
      level: 2,
    });
    expect(focus.neighbours.b).toMatchObject({
      parent: "r1",
      firstChild: null,
      prev: "a",
      next: null,
      position: 2,
    });
  });

  it("treats roots as siblings of each other", () => {
    expect(focus.neighbours.r1).toMatchObject({
      parent: null,
      prev: null,
      next: "r2",
      level: 1,
      setSize: 2,
    });
    expect(focus.firstRoot).toBe("r1");
    expect(focus.lastRoot).toBe("r2");
  });

  it("has no roots for an empty layout", () => {
    expect(focusNeighbours(layoutOrgChart([]))).toEqual({
      ids: [],
      neighbours: {},
      firstRoot: null,
      lastRoot: null,
    });
  });
});
