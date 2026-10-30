import { describe, expect, it } from "vitest";
import {
  MIN_HEIGHT,
  PAD_Y,
  ROW_GAP,
  TILE,
  TREE_WIDTH,
  standingWave,
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

describe("standingWave", () => {
  const args = { x: 40, y0: 0, y1: 300, amplitude: 12, segment: 100 };

  it("shares its nodes and endpoints between both flips", () => {
    const rest = points(standingWave({ ...args, flip: false }));
    const peak = points(standingWave({ ...args, flip: true }));
    expect(rest.at(0)).toEqual(peak.at(0));
    expect(rest.at(-1)).toEqual(peak.at(-1));
    expect(rest.at(-1)).toEqual([40, 300]);
  });

  it("uses at least one segment for a short run", () => {
    expect(commands(standingWave({ ...args, y1: 10, flip: false }))).toBe("MC");
  });
});

describe("treeLayout", () => {
  const layout = treeLayout(4);

  it("has one branch per tile and three free lines", () => {
    expect(layout.strands.filter((s) => s.tileIndex !== null)).toHaveLength(4);
    expect(layout.strands.filter((s) => s.tileIndex === null)).toHaveLength(3);
  });

  it("keeps rest and peak on the same command sequence", () => {
    for (const strand of layout.strands) {
      expect(commands(strand.peak)).toBe(commands(strand.rest));
    }
  });

  it("ends each branch on its tile's left edge in both keyframes", () => {
    for (const strand of layout.strands) {
      if (strand.tileIndex === null) continue;
      const end: [number, number] = [TREE_WIDTH, tileCenterY(strand.tileIndex)];
      expect(points(strand.rest).at(-1)).toEqual(end);
      expect(points(strand.peak).at(-1)).toEqual(end);
    }
  });

  it("keeps every x inside the line column", () => {
    for (const strand of treeLayout(7).strands) {
      for (const path of [strand.rest, strand.peak]) {
        for (const [x] of points(path)) {
          expect(x).toBeGreaterThanOrEqual(0);
          expect(x).toBeLessThanOrEqual(TREE_WIDTH);
        }
      }
    }
  });

  it("is deterministic for a given count", () => {
    expect(treeLayout(4)).toEqual(treeLayout(4));
  });

  it("reports the width and the formula height", () => {
    expect(layout.width).toBe(TREE_WIDTH);
    expect(layout.height).toBe(treeHeight(4));
  });
});
