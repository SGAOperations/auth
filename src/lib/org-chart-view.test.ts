import { describe, expect, it } from "vitest";
import {
  clampPan,
  clampScale,
  fitView,
  panBy,
  pinchView,
  revealView,
  wheelFactor,
  zoomAt,
  type View,
} from "@/lib/org-chart-view";

const toScreen = (view: View, p: { x: number; y: number }) => ({
  x: p.x * view.scale + view.x,
  y: p.y * view.scale + view.y,
});

describe("clampScale", () => {
  it("limits to 0.25 and 2", () => {
    expect(clampScale(0.01)).toBe(0.25);
    expect(clampScale(9)).toBe(2);
    expect(clampScale(1.2)).toBe(1.2);
  });
});

describe("panBy", () => {
  it("moves the view", () => {
    expect(panBy({ x: 1, y: 2, scale: 1 }, 10, -5)).toEqual({
      x: 11,
      y: -3,
      scale: 1,
    });
  });
});

describe("zoomAt", () => {
  it("keeps the anchor point fixed", () => {
    const view = { x: 30, y: -10, scale: 1 };
    const anchor = { x: 120, y: 80 };
    const chartPoint = {
      x: (anchor.x - view.x) / view.scale,
      y: (anchor.y - view.y) / view.scale,
    };
    const zoomed = zoomAt(view, 1.5, anchor);
    expect(zoomed.scale).toBe(1.5);
    const after = toScreen(zoomed, chartPoint);
    expect(after.x).toBeCloseTo(anchor.x);
    expect(after.y).toBeCloseTo(anchor.y);
  });

  it("stops at the limits without drifting", () => {
    const view = { x: 5, y: 5, scale: 2 };
    expect(zoomAt(view, 3, { x: 50, y: 50 })).toEqual(view);
  });
});

describe("wheelFactor", () => {
  it("zooms in on scroll up and out on scroll down", () => {
    expect(wheelFactor(-100, false)).toBeGreaterThan(1);
    expect(wheelFactor(100, false)).toBeLessThan(1);
    expect(wheelFactor(0, false)).toBe(1);
  });

  it("is stronger for a ctrl pinch", () => {
    expect(wheelFactor(-10, true)).toBeGreaterThan(wheelFactor(-10, false));
  });
});

describe("pinchView", () => {
  const start = {
    view: { x: 0, y: 0, scale: 1 },
    a: { x: 100, y: 100 },
    b: { x: 200, y: 100 },
  };

  it("scales with the change in distance", () => {
    const view = pinchView(start, { x: 50, y: 100 }, { x: 250, y: 100 });
    expect(view.scale).toBeCloseTo(2);
  });

  it("keeps the chart point under the midpoint with it", () => {
    const a = { x: 80, y: 120 };
    const b = { x: 280, y: 120 };
    const view = pinchView(start, a, b);
    const chartPoint = { x: 150, y: 100 };
    const screen = toScreen(view, chartPoint);
    expect(screen.x).toBeCloseTo(180);
    expect(screen.y).toBeCloseTo(120);
  });

  it("clamps the scale and survives coincident start points", () => {
    expect(pinchView(start, { x: 0, y: 0 }, { x: 1000, y: 0 }).scale).toBe(2);
    const degenerate = { ...start, b: start.a };
    expect(pinchView(degenerate, { x: 0, y: 0 }, { x: 50, y: 0 }).scale).toBe(
      1,
    );
  });
});

describe("fitView", () => {
  const viewport = { width: 800, height: 600 };

  it("centres a tiny chart at scale 1", () => {
    const view = fitView({ width: 200, height: 88 }, viewport);
    expect(view.scale).toBe(1);
    expect(view.x).toBe(300);
    expect(view.y).toBe(256);
  });

  it("shrinks a wide chart to fit", () => {
    const view = fitView({ width: 1536, height: 88 }, viewport);
    expect(view.scale).toBeCloseTo((800 - 32) / 1536);
    expect(view.x).toBeCloseTo(16);
  });

  it("shrinks a tall chart to fit", () => {
    const view = fitView({ width: 200, height: 1068 }, viewport);
    expect(view.scale).toBeCloseTo((600 - 32) / 1068);
  });

  it("floors at 0.5 and aligns top-left when the chart is too large", () => {
    const view = fitView({ width: 5000, height: 3000 }, viewport);
    expect(view).toEqual({ scale: 0.5, x: 16, y: 16 });
  });

  it("returns the identity for an empty chart", () => {
    expect(fitView({ width: 0, height: 0 }, viewport)).toEqual({
      x: 0,
      y: 0,
      scale: 1,
    });
  });
});

describe("revealView", () => {
  const viewport = { width: 400, height: 300 };
  const view = { x: 0, y: 0, scale: 1 };

  it("leaves a visible rect alone", () => {
    const rect = { x: 50, y: 50, width: 100, height: 50 };
    expect(revealView(view, rect, viewport, 16)).toBe(view);
  });

  it("pans a rect off the right and bottom into view", () => {
    const rect = { x: 500, y: 400, width: 100, height: 50 };
    const next = revealView(view, rect, viewport, 16);
    const screen = toScreen(next, rect);
    expect(screen.x + rect.width).toBe(400 - 16);
    expect(screen.y + rect.height).toBe(300 - 16);
  });

  it("pans a rect off the left and top into view", () => {
    const rect = { x: -300, y: -200, width: 100, height: 50 };
    const next = revealView(view, rect, viewport, 16);
    const screen = toScreen(next, rect);
    expect(screen.x).toBe(16);
    expect(screen.y).toBe(16);
  });

  it("aligns a rect larger than the viewport to the margin", () => {
    const rect = { x: 100, y: 0, width: 900, height: 50 };
    const next = revealView(view, rect, viewport, 16);
    expect(toScreen(next, rect).x).toBe(16);
  });
});

describe("clampPan", () => {
  const content = { width: 1000, height: 500 };
  const viewport = { width: 400, height: 300 };

  it("leaves a sensible pan alone", () => {
    const view = { x: -100, y: 20, scale: 1 };
    expect(clampPan(view, content, viewport)).toEqual(view);
  });

  it("keeps a strip of the chart on screen", () => {
    const farLeft = clampPan({ x: -9999, y: 0, scale: 1 }, content, viewport);
    expect(farLeft.x).toBe(80 - 1000);
    const farRight = clampPan(
      { x: 9999, y: 9999, scale: 1 },
      content,
      viewport,
    );
    expect(farRight.x).toBe(400 - 80);
    expect(farRight.y).toBe(300 - 80);
  });

  it("does not demand more than the chart's own size", () => {
    const tiny = clampPan(
      { x: 9999, y: 0, scale: 1 },
      { width: 40, height: 40 },
      viewport,
    );
    expect(tiny.x).toBe(400 - 40);
  });
});
