import { describe, expect, it } from "vitest";
import {
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
