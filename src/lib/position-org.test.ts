import { describe, expect, it } from "vitest";
import {
  buildOrgTree,
  descendantsOf,
  managerChain,
  wouldCreateCycle,
  type ManagerNode,
} from "@/lib/position-org";

// a <- b <- c <- d: d reports to c, c to b, b to a. e is a separate root.
const nodes: ManagerNode[] = [
  { id: "a", managerPositionId: null },
  { id: "b", managerPositionId: "a" },
  { id: "c", managerPositionId: "b" },
  { id: "d", managerPositionId: "c" },
  { id: "e", managerPositionId: null },
];

describe("wouldCreateCycle", () => {
  it("rejects a position as its own manager", () => {
    expect(wouldCreateCycle(nodes, "b", "b")).toBe(true);
  });

  it("rejects a direct cycle", () => {
    expect(wouldCreateCycle(nodes, "a", "b")).toBe(true);
  });

  it("rejects a cycle three levels deep", () => {
    expect(wouldCreateCycle(nodes, "a", "d")).toBe(true);
  });

  it("accepts a valid re-parent", () => {
    expect(wouldCreateCycle(nodes, "d", "a")).toBe(false);
    expect(wouldCreateCycle(nodes, "c", "e")).toBe(false);
  });

  it("accepts a manager missing from the graph", () => {
    expect(wouldCreateCycle(nodes, "a", "gone")).toBe(false);
  });

  it("terminates on a loop that already exists elsewhere", () => {
    const looped: ManagerNode[] = [
      { id: "x", managerPositionId: "y" },
      { id: "y", managerPositionId: "x" },
      { id: "z", managerPositionId: null },
    ];
    expect(wouldCreateCycle(looped, "z", "x")).toBe(false);
  });
});

describe("managerChain", () => {
  it("lists managers from the immediate one up to the root", () => {
    expect(managerChain(nodes, "d").map((node) => node.id)).toEqual([
      "c",
      "b",
      "a",
    ]);
  });

  it("is empty for a root and for an unknown position", () => {
    expect(managerChain(nodes, "a")).toEqual([]);
    expect(managerChain(nodes, "missing")).toEqual([]);
  });

  it("stops at a manager missing from the graph", () => {
    const orphaned: ManagerNode[] = [{ id: "p", managerPositionId: "deleted" }];
    expect(managerChain(orphaned, "p")).toEqual([]);
  });

  it("terminates on a pre-existing loop", () => {
    const looped: ManagerNode[] = [
      { id: "x", managerPositionId: "y" },
      { id: "y", managerPositionId: "x" },
    ];
    expect(managerChain(looped, "x").map((node) => node.id)).toEqual(["y"]);
  });
});

const ids = (list: readonly { node: ManagerNode }[]) =>
  list.map((entry) => entry.node.id);

describe("buildOrgTree", () => {
  it("nests a chain and leaves a lone position unlinked", () => {
    const { roots, unlinked } = buildOrgTree(nodes);
    expect(ids(roots)).toEqual(["a"]);
    expect(ids(roots[0].reports)).toEqual(["b"]);
    expect(ids(roots[0].reports[0].reports)).toEqual(["c"]);
    expect(ids(roots[0].reports[0].reports[0].reports)).toEqual(["d"]);
    expect(unlinked.map((node) => node.id)).toEqual(["e"]);
  });

  it("returns several roots in input order", () => {
    const { roots, unlinked } = buildOrgTree([
      { id: "r2", managerPositionId: null },
      { id: "r1", managerPositionId: null },
      { id: "k1", managerPositionId: "r1" },
      { id: "k2", managerPositionId: "r2" },
    ]);
    expect(ids(roots)).toEqual(["r2", "r1"]);
    expect(unlinked).toEqual([]);
  });

  it("keeps siblings in input order", () => {
    const { roots } = buildOrgTree([
      { id: "boss", managerPositionId: null },
      { id: "z", managerPositionId: "boss" },
      { id: "a", managerPositionId: "boss" },
      { id: "m", managerPositionId: "boss" },
    ]);
    expect(ids(roots[0].reports)).toEqual(["z", "a", "m"]);
  });

  it("treats a report whose manager is missing as a root", () => {
    const { roots, unlinked } = buildOrgTree([
      { id: "p", managerPositionId: "deleted" },
      { id: "q", managerPositionId: "p" },
    ]);
    expect(ids(roots)).toEqual(["p"]);
    expect(ids(roots[0].reports)).toEqual(["q"]);
    expect(unlinked).toEqual([]);
  });

  it("returns nothing for an empty input", () => {
    expect(buildOrgTree([])).toEqual({ roots: [], unlinked: [] });
  });

  it("terminates on a manufactured loop without losing or duplicating nodes", () => {
    const { roots, unlinked } = buildOrgTree([
      { id: "x", managerPositionId: "y" },
      { id: "y", managerPositionId: "x" },
      { id: "s", managerPositionId: "s" },
      { id: "h", managerPositionId: null },
      { id: "k", managerPositionId: "h" },
    ]);
    expect(ids(roots)).toEqual(["h"]);
    expect(ids(roots[0].reports)).toEqual(["k"]);
    expect(unlinked.map((node) => node.id)).toEqual(["x", "y", "s"]);
  });
});

describe("descendantsOf", () => {
  it("returns direct and indirect reports", () => {
    expect(descendantsOf(nodes, "a")).toEqual(new Set(["b", "c", "d"]));
    expect(descendantsOf(nodes, "c")).toEqual(new Set(["d"]));
  });

  it("is empty for a leaf and for an unknown position", () => {
    expect(descendantsOf(nodes, "d").size).toBe(0);
    expect(descendantsOf(nodes, "missing").size).toBe(0);
  });

  it("terminates on a pre-existing loop and never lists the position itself", () => {
    const looped: ManagerNode[] = [
      { id: "x", managerPositionId: "y" },
      { id: "y", managerPositionId: "x" },
    ];
    expect(descendantsOf(looped, "x")).toEqual(new Set(["y"]));
  });
});
