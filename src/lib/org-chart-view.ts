// Pure pan and zoom math for the org chart canvas. Client-safe. A view maps
// chart coordinates to the viewport: screen = chart * scale + (x, y).

export type View = { x: number; y: number; scale: number };
export type Point = { x: number; y: number };
export type Size = { width: number; height: number };
export type Rect = Point & Size;

export const MIN_SCALE = 0.25;
export const MAX_SCALE = 2;
/** Fit never goes below this, so text stays readable on a phone. */
export const FIT_FLOOR = 0.5;
const FIT_PADDING = 16;
/** How much of the chart must stay on screen when panning. */
const KEEP_VISIBLE = 80;

export const IDENTITY_VIEW: View = { x: 0, y: 0, scale: 1 };

export function clampScale(scale: number): number {
  return Math.min(MAX_SCALE, Math.max(MIN_SCALE, scale));
}

export function panBy(view: View, dx: number, dy: number): View {
  return { ...view, x: view.x + dx, y: view.y + dy };
}

/** Scale by `factor` (clamped) keeping the chart point under `anchor` fixed. */
export function zoomAt(view: View, factor: number, anchor: Point): View {
  const scale = clampScale(view.scale * factor);
  const ratio = scale / view.scale;
  return {
    scale,
    x: anchor.x - (anchor.x - view.x) * ratio,
    y: anchor.y - (anchor.y - view.y) * ratio,
  };
}

/** The zoom factor for one wheel event. A trackpad pinch arrives as ctrl+wheel. */
export function wheelFactor(deltaY: number, ctrlKey: boolean): number {
  return Math.exp(-deltaY * (ctrlKey ? 0.01 : 0.0015));
}

/**
 * The view for a two-pointer pinch: scale follows the change in distance and
 * the chart point that was under the starting midpoint follows the new one.
 */
export function pinchView(
  start: { view: View; a: Point; b: Point },
  a: Point,
  b: Point,
): View {
  const startDistance = Math.hypot(
    start.a.x - start.b.x,
    start.a.y - start.b.y,
  );
  const distance = Math.hypot(a.x - b.x, a.y - b.y);
  const startMid = {
    x: (start.a.x + start.b.x) / 2,
    y: (start.a.y + start.b.y) / 2,
  };
  const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
  const scale = clampScale(
    startDistance === 0
      ? start.view.scale
      : (start.view.scale * distance) / startDistance,
  );
  const chartX = (startMid.x - start.view.x) / start.view.scale;
  const chartY = (startMid.y - start.view.y) / start.view.scale;
  return { scale, x: mid.x - chartX * scale, y: mid.y - chartY * scale };
}

/**
 * Fit the chart in the viewport, never enlarging past 1. When that would be
 * smaller than the floor, use the floor and align top-left so the chart stays
 * readable and the user pans. A chart that fits is centred.
 */
export function fitView(content: Size, viewport: Size): View {
  if (content.width <= 0 || content.height <= 0) return IDENTITY_VIEW;
  const fit = Math.min(
    1,
    (viewport.width - FIT_PADDING * 2) / content.width,
    (viewport.height - FIT_PADDING * 2) / content.height,
  );
  if (fit < FIT_FLOOR) {
    return { scale: FIT_FLOOR, x: FIT_PADDING, y: FIT_PADDING };
  }
  return {
    scale: fit,
    x: (viewport.width - content.width * fit) / 2,
    y: (viewport.height - content.height * fit) / 2,
  };
}

/**
 * Pan just enough to bring `rect` (chart coordinates) inside the viewport with
 * `margin` to spare. A rect already in view leaves the view untouched; one too
 * large to fit is aligned to the top-left margin.
 */
export function revealView(
  view: View,
  rect: Rect,
  viewport: Size,
  margin: number,
): View {
  const left = rect.x * view.scale + view.x;
  const top = rect.y * view.scale + view.y;
  const right = left + rect.width * view.scale;
  const bottom = top + rect.height * view.scale;

  const shift = (low: number, high: number, limit: number): number => {
    if (high - low > limit - margin * 2 || low < margin) return margin - low;
    if (high > limit - margin) return limit - margin - high;
    return 0;
  };

  const dx = shift(left, right, viewport.width);
  const dy = shift(top, bottom, viewport.height);
  return dx === 0 && dy === 0 ? view : panBy(view, dx, dy);
}

/** Keep at least a strip of the chart on screen so it cannot be lost. */
export function clampPan(view: View, content: Size, viewport: Size): View {
  const width = content.width * view.scale;
  const height = content.height * view.scale;
  const keepX = Math.min(KEEP_VISIBLE, width);
  const keepY = Math.min(KEEP_VISIBLE, height);
  return {
    scale: view.scale,
    x: Math.min(viewport.width - keepX, Math.max(keepX - width, view.x)),
    y: Math.min(viewport.height - keepY, Math.max(keepY - height, view.y)),
  };
}
