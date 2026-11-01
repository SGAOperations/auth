import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

// #308 moves the logo into public/product-icons/; follow it so this test keeps
// guarding the file whichever side of that move the branch is on.
const MOVED = join(process.cwd(), "public/product-icons/vaultz-logo.svg");
const ORIGINAL = join(process.cwd(), "public/vaultz-logo.svg");
const svg = readFileSync(existsSync(MOVED) ? MOVED : ORIGINAL, "utf8");

// The extents of the glyph path, in its own coordinates.
const GLYPH_WIDTH = 348;
const GLYPH_HEIGHT = 287;
const MIN_MARGIN = 0.15;

function viewBox(): [number, number, number, number] {
  const raw = /viewBox="([^"]+)"/.exec(svg)?.[1] ?? "";
  const [x, y, w, h] = raw.split(/\s+/).map(Number);
  return [x, y, w, h];
}

describe("VaultZ logo", () => {
  it("is drawn on a square canvas", () => {
    const [, , w, h] = viewBox();
    expect(w).toBeGreaterThan(0);
    expect(w).toBe(h);
  });

  it("leaves at least 15% of the side as margin around the glyph", () => {
    const [x, y, w, h] = viewBox();
    const margin = MIN_MARGIN * w;
    expect(0 - x).toBeGreaterThanOrEqual(margin);
    expect(0 - y).toBeGreaterThanOrEqual(margin);
    expect(x + w - GLYPH_WIDTH).toBeGreaterThanOrEqual(margin);
    expect(y + h - GLYPH_HEIGHT).toBeGreaterThanOrEqual(margin);
  });

  it("has no background rect: the tile's tone is the purple", () => {
    expect(svg).not.toContain("<rect");
  });
});
