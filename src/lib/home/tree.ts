// Pure and client-safe geometry for the home page's product tree. The explorer's
// Tailwind spacing must equal these constants: `pl-[5.5rem]` is TREE_WIDTH,
// `pt-10` is PAD_Y, `gap-5` is ROW_GAP and `size-14` is TILE (docs/DESIGN.md).

/** Width of the line column, px. Tiles start at its right edge. */
export const TREE_WIDTH = 88;
export const TILE = 56;
export const ROW_GAP = 20;
export const PAD_Y = 40;
export const MIN_HEIGHT = 352;
/** The x the waving lines are centred on. */
export const CENTER_X = 40;
/** Vertical run of the fixed turn into a tile. */
export const BEND = 24;

const BRANCH_LANES = [-10, 6, -2, 12, -14, 2] as const;
const FREE_STRANDS = [
  { lane: -16, amplitude: 18, segment: 120, seconds: 9 },
  { lane: 0, amplitude: 12, segment: 150, seconds: 12 },
  { lane: 14, amplitude: 20, segment: 100, seconds: 14 },
] as const;

export interface TreeStrand {
  id: string;
  /** The tile this line ends at, or `null` for a free line. */
  tileIndex: number | null;
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
 * A vertical line that sways about `x`: cubic segments whose control points sit
 * on alternating sides. Every node lies on `x`, so the `flip: false` and
 * `flip: true` curves share all nodes and both endpoints, and differ only in
 * which side each segment bulges to.
 */
export function standingWave({
  x,
  y0,
  y1,
  amplitude,
  segment,
  flip,
}: {
  x: number;
  y0: number;
  y1: number;
  amplitude: number;
  segment: number;
  flip: boolean;
}): string {
  const k = Math.max(1, Math.round((y1 - y0) / segment));
  const h = (y1 - y0) / k;
  const parts = [`M ${fmt(x)} ${fmt(y0)}`];
  for (let j = 0; j < k; j += 1) {
    const sign = (j % 2 === 0 ? 1 : -1) * (flip ? -1 : 1);
    const cx = x + sign * amplitude;
    const top = y0 + j * h;
    parts.push(
      `C ${fmt(cx)} ${fmt(top + h / 3)} ${fmt(cx)} ${fmt(top + (2 * h) / 3)} ${fmt(x)} ${fmt(top + h)}`,
    );
  }
  return parts.join(" ");
}

function branchStrand(index: number): TreeStrand {
  const x = CENTER_X + BRANCH_LANES[index % BRANCH_LANES.length];
  const yc = tileCenterY(index);
  const seconds = 7 + ((index * 2) % 5);
  const wave = {
    x,
    y0: -8,
    y1: yc - BEND,
    amplitude: 10 + ((index * 3) % 7),
    segment: 70 + ((index * 17) % 41),
  };
  // One fixed turn into the tile, identical in both keyframes, so the line
  // always ends on the tile's left edge however far the rest of it sways.
  const turn = ` C ${fmt(x)} ${fmt(yc)} ${fmt((x + TREE_WIDTH) / 2)} ${fmt(yc)} ${fmt(TREE_WIDTH)} ${fmt(yc)}`;
  return {
    id: `branch-${index}`,
    tileIndex: index,
    rest: standingWave({ ...wave, flip: false }) + turn,
    peak: standingWave({ ...wave, flip: true }) + turn,
    seconds,
    delaySeconds: Number(((index * 1.7) % seconds).toFixed(1)),
  };
}

function freeStrand(index: number, height: number): TreeStrand {
  const spec = FREE_STRANDS[index];
  const wave = {
    x: CENTER_X + spec.lane,
    y0: -8,
    y1: height + 8,
    amplitude: spec.amplitude,
    segment: spec.segment,
  };
  return {
    id: `free-${index}`,
    tileIndex: null,
    rest: standingWave({ ...wave, flip: false }),
    peak: standingWave({ ...wave, flip: true }),
    seconds: spec.seconds,
    delaySeconds: Number(((index * 3.1) % spec.seconds).toFixed(1)),
  };
}

export function treeLayout(count: number): TreeLayout {
  const height = treeHeight(count);
  return {
    width: TREE_WIDTH,
    height,
    strands: [
      ...Array.from({ length: count }, (_, i) => branchStrand(i)),
      ...FREE_STRANDS.map((_, i) => freeStrand(i, height)),
    ],
  };
}
