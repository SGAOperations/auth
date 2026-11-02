// Pure and client-safe geometry for the home page's product tree: one curved
// branch per tile. Every branch starts on the ray at the top of the tree and
// ends on its tile's left edge. The explorer's Tailwind spacing must equal
// these constants: `pl-[5.5rem]` is TREE_WIDTH, `pt-10` is PAD_Y, `gap-5` is
// ROW_GAP and `size-14` is TILE. The ray sits `--ray-gap` (at most ROOT_RUN px)
// left of the tile column (docs/DESIGN.md).

/** Width of the line column, px. Tiles start at its right edge. */
export const TREE_WIDTH = 88;
/** The widest root-to-tile distance, px: `--ray-gap` at `>= 70rem` (3.5rem). */
export const ROOT_RUN = 56;
export const TILE = 56;
export const ROW_GAP = 20;
export const PAD_Y = 40;
export const MIN_HEIGHT = 352;

export interface TreeStrand {
  id: string;
  /** The tile this branch ends at. */
  tileIndex: number;
  rest: string;
  peak: string;
  seconds: number;
  delaySeconds: number;
}

export interface TreeLayout {
  width: number;
  height: number;
  strands: TreeStrand[];
}

export function tileCenterY(index: number): number {
  return PAD_Y + index * (TILE + ROW_GAP) + TILE / 2;
}

export function treeHeight(count: number): number {
  return Math.max(
    MIN_HEIGHT,
    2 * PAD_Y + count * TILE + Math.max(0, count - 1) * ROW_GAP,
  );
}

function fmt(value: number): string {
  return String(Number(value.toFixed(2)));
}

/**
 * One cubic from the ray (x = 0, vertical tangent) to the tile's left edge
 * (horizontal tangent). `rest` and `peak` share both end points and differ only
 * in the two control points' y, so the root stays on the ray and the tip on the
 * tile while the middle sways.
 */
function branchStrand(index: number): TreeStrand {
  const width = ROOT_RUN + TREE_WIDTH;
  const yc = tileCenterY(index);
  const y0 = 0;
  const sway = 5 + ((index * 3) % 4);
  const curve = (c1y: number, c2y: number) =>
    `M 0 ${fmt(y0)} C 0 ${fmt(c1y)} ${fmt(width / 2)} ${fmt(c2y)} ${fmt(width)} ${fmt(yc)}`;
  const seconds = 7 + ((index * 2) % 5);
  return {
    id: `branch-${index}`,
    tileIndex: index,
    rest: curve(yc, yc),
    peak: curve(yc - sway, yc + sway),
    seconds,
    delaySeconds: Number(((index * 1.7) % seconds).toFixed(1)),
  };
}

export function treeLayout(count: number): TreeLayout {
  return {
    width: ROOT_RUN + TREE_WIDTH,
    height: treeHeight(count),
    strands: Array.from({ length: count }, (_, i) => branchStrand(i)),
  };
}
