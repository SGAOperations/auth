import { describe, expect, it } from "vitest";
import {
  MIN_HEIGHT,
  PAD_Y,
  ROOT_RUN,
  ROW_GAP,
  TILE,
  TREE_WIDTH,
  tileCenterY,
  treeHeight,
  treeLayout,
} from "@/lib/home/tree";

function commands(path: string): string {
  return path.match(/[A-Za-z]/g)?.join("") ?? "";
}

function points(path: string): [number, number][] {
  const numbers = (path.match(/-?\d+(?:\.\d+)?/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < numbers.length; i += 2) {
    out.push([numbers[i], numbers[i + 1]]);
  }
  return out;
}

describe("treeHeight", () => {
  it("follows the row formula above the floor", () => {
    expect(treeHeight(5)).toBe(2 * PAD_Y + 5 * TILE + 4 * ROW_GAP);
  });

  it("never drops below MIN_HEIGHT", () => {
    expect(treeHeight(1)).toBe(MIN_HEIGHT);
    expect(treeHeight(3)).toBe(MIN_HEIGHT);
  });
});

describe("treeLayout", () => {
  const layout = treeLayout(4);

  it("has one branch per tile and no others", () => {
    expect(layout.strands).toHaveLength(4);
    expect(layout.strands.map((s) => s.tileIndex)).toEqual([0, 1, 2, 3]);
  });

  it("keeps rest and peak on the same command sequence", () => {
    for (const strand of layout.strands) {
      expect(commands(strand.peak)).toBe(commands(strand.rest));
    }
  });

  it("starts each branch on the ray (x = 0) in both keyframes", () => {
    for (const strand of layout.strands) {
      expect(points(strand.rest).at(0)?.[0]).toBe(0);
      expect(points(strand.peak).at(0)?.[0]).toBe(0);
      expect(points(strand.peak).at(0)).toEqual(points(strand.rest).at(0));
    }
  });

  it("starts at or below the top of the tree", () => {
    for (const strand of treeLayout(7).strands) {
      for (const path of [strand.rest, strand.peak]) {
        expect(points(path).at(0)?.[1]).toBeGreaterThanOrEqual(0);
      }
    }
  });

  it("ends each branch on its tile's left edge in both keyframes", () => {
    for (const strand of layout.strands) {
      const end: [number, number] = [
        layout.width,
        tileCenterY(strand.tileIndex),
      ];
      expect(points(strand.rest).at(-1)).toEqual(end);
      expect(points(strand.peak).at(-1)).toEqual(end);
    }
  });

  it("keeps every x inside the branch column", () => {
    for (const strand of treeLayout(7).strands) {
      for (const path of [strand.rest, strand.peak]) {
        for (const [x] of points(path)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(layout.width);
        }
      }
    }
  });

  it("is deterministic for a given count", () => {
    expect(treeLayout(4)).toEqual(treeLayout(4));
  });

  it("reports the width and the formula height", () => {
    expect(layout.width).toBe(ROOT_RUN + TREE_WIDTH);
    expect(layout.height).toBe(treeHeight(4));
  });
});
