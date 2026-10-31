"use client";

import { Maximize, ZoomIn, ZoomOut } from "lucide-react";
import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { useMotionPreference } from "@/hooks/use-motion-preference";
import type { OrgChartPosition } from "@/lib/org-chart";
import {
  DEFAULT_SIZES,
  edgePath,
  focusNeighbours,
  layoutOrgChart,
} from "@/lib/org-chart-layout";
import {
  IDENTITY_VIEW,
  MAX_SCALE,
  MIN_SCALE,
  clampPan,
  fitView,
  panBy,
  pinchView,
  revealView,
  wheelFactor,
  zoomAt,
  type Point,
  type Size,
  type View,
} from "@/lib/org-chart-view";
import type { OrgTreeNode } from "@/lib/position-org";
import { cn } from "@/lib/utils";

const SIZES = DEFAULT_SIZES;
const ZOOM_STEP = 1.25;
const PAN_STEP = 80;
const REVEAL_MARGIN = 24;

type Gesture =
  | { kind: "pan"; last: Point }
  | { kind: "pinch"; start: { view: View; a: Point; b: Point } };

type NodeInfo = { position: OrgChartPosition; managerName: string | null };

function indexPositions(
  roots: readonly OrgTreeNode<OrgChartPosition>[],
): Map<string, NodeInfo> {
  const info = new Map<string, NodeInfo>();
  const pending = roots.map((entry) => ({
    entry,
    managerName: null as string | null,
  }));
  while (pending.length > 0) {
    const next = pending.pop();
    if (next === undefined) break;
    const { entry, managerName } = next;
    info.set(entry.node.id, { position: entry.node, managerName });
    for (const report of entry.reports) {
      pending.push({ entry: report, managerName: entry.node.name });
    }
  }
  return info;
}

function accessibleName({ position, managerName }: NodeInfo): string {
  return [
    position.name,
    position.category,
    position.isLeadership ? "Leadership" : null,
    managerName ? `reports to ${managerName}` : null,
  ]
    .filter(Boolean)
    .join(", ");
}

/**
 * The reporting hierarchy as a pannable, zoomable chart. One transformed layer
 * holds an SVG for the lines and absolutely positioned HTML cards for the
 * positions, so both move and scale together. Input handling is here; the
 * layout and view math live in `org-chart-layout` and `org-chart-view`.
 */
export function OrgChartCanvas({
  roots,
}: {
  roots: readonly OrgTreeNode<OrgChartPosition>[];
}) {
  const layout = useMemo(() => layoutOrgChart(roots), [roots]);
  const focus = useMemo(() => focusNeighbours(layout), [layout]);
  const info = useMemo(() => indexPositions(roots), [roots]);
  const content = useMemo<Size>(
    () => ({ width: layout.width, height: layout.height }),
    [layout],
  );
  const placed = useMemo(
    () => new Map(layout.nodes.map((node) => [node.id, node])),
    [layout],
  );

  const { prefersReduced, paused } = useMotionPreference();
  const canAnimate = !prefersReduced && !paused;

  const hintId = useId();
  const [view, setView] = useState<View>(IDENTITY_VIEW);
  const [ready, setReady] = useState(false);
  const [animated, setAnimated] = useState(false);
  const [activeId, setActiveId] = useState<string | null>(null);

  const viewportRef = useRef<HTMLDivElement>(null);
  const nodeRefs = useRef(new Map<string, HTMLDivElement>());
  const viewRef = useRef<View>(IDENTITY_VIEW);
  const sizeRef = useRef<Size | null>(null);
  const fittedRef = useRef(false);
  const pointers = useRef(new Map<number, Point>());
  const gesture = useRef<Gesture | null>(null);

  const commit = useCallback(
    (next: View, animate = false) => {
      const size = sizeRef.current;
      const clamped = size ? clampPan(next, content, size) : next;
      viewRef.current = clamped;
      setAnimated(animate && canAnimate);
      setView(clamped);
    },
    [content, canAnimate],
  );

  // Fit once on the first measure, never again after the person has moved.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[0]?.contentRect;
      if (!box || box.width === 0 || box.height === 0) return;
      sizeRef.current = { width: box.width, height: box.height };
      if (fittedRef.current) return;
      fittedRef.current = true;
      commit(fitView(content, sizeRef.current));
      setReady(true);
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [commit, content]);

  // Native and non-passive so preventDefault stops the page scrolling.
  useEffect(() => {
    const element = viewportRef.current;
    if (!element) return;
    const onWheel = (event: WheelEvent) => {
      event.preventDefault();
      const box = element.getBoundingClientRect();
      const delta = event.deltaMode === 1 ? event.deltaY * 16 : event.deltaY;
      commit(
        zoomAt(viewRef.current, wheelFactor(delta, event.ctrlKey), {
          x: event.clientX - box.left,
          y: event.clientY - box.top,
        }),
      );
    };
    element.addEventListener("wheel", onWheel, { passive: false });
    return () => element.removeEventListener("wheel", onWheel);
  }, [commit]);

  const localPoint = (event: PointerEvent): Point => {
    const box = event.currentTarget.getBoundingClientRect();
    return { x: event.clientX - box.left, y: event.clientY - box.top };
  };

  const restartGesture = () => {
    const points = Array.from(pointers.current.values());
    if (points.length >= 2) {
      gesture.current = {
        kind: "pinch",
        start: { view: viewRef.current, a: points[0], b: points[1] },
      };
    } else if (points.length === 1) {
      gesture.current = { kind: "pan", last: points[0] };
    } else {
      gesture.current = null;
    }
  };

  const onPointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (event.pointerType === "mouse" && event.button !== 0) return;
    pointers.current.set(event.pointerId, localPoint(event));
    event.currentTarget.setPointerCapture(event.pointerId);
    restartGesture();
  };

  const onPointerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.has(event.pointerId)) return;
    const point = localPoint(event);
    pointers.current.set(event.pointerId, point);
    const current = gesture.current;
    if (current?.kind === "pan") {
      commit(
        panBy(
          viewRef.current,
          point.x - current.last.x,
          point.y - current.last.y,
        ),
      );
      current.last = point;
    } else if (current?.kind === "pinch") {
      const [a, b] = Array.from(pointers.current.values());
      commit(pinchView(current.start, a, b));
    }
  };

  const onPointerEnd = (event: PointerEvent<HTMLDivElement>) => {
    if (!pointers.current.delete(event.pointerId)) return;
    restartGesture();
  };

  const zoomFromCentre = (factor: number) => {
    const size = sizeRef.current;
    if (!size) return;
    commit(
      zoomAt(viewRef.current, factor, {
        x: size.width / 2,
        y: size.height / 2,
      }),
      true,
    );
  };

  const fit = () => {
    const size = sizeRef.current;
    if (size) commit(fitView(content, size), true);
  };

  const revealNode = (id: string) => {
    const node = placed.get(id);
    const size = sizeRef.current;
    if (!node || !size) return;
    commit(
      revealView(
        viewRef.current,
        {
          x: node.x,
          y: node.y,
          width: SIZES.nodeWidth,
          height: SIZES.nodeHeight,
        },
        size,
        REVEAL_MARGIN,
      ),
      true,
    );
  };

  const focusNode = (id: string) => {
    setActiveId(id);
    nodeRefs.current.get(id)?.focus({ preventScroll: true });
    revealNode(id);
  };

  const onNodeFocus = (id: string) => {
    setActiveId(id);
    // The browser may scroll the clipped viewport to a focused card; undo it.
    const element = viewportRef.current;
    if (element) {
      element.scrollLeft = 0;
      element.scrollTop = 0;
    }
    revealNode(id);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    const id =
      (event.target as HTMLElement).closest<HTMLElement>("[data-node-id]")
        ?.dataset.nodeId ?? null;
    const current = id ? focus.neighbours[id] : undefined;

    const panKeys: Record<string, [number, number]> = {
      ArrowLeft: [PAN_STEP, 0],
      ArrowRight: [-PAN_STEP, 0],
      ArrowUp: [0, PAN_STEP],
      ArrowDown: [0, -PAN_STEP],
    };
    if (event.shiftKey && event.key in panKeys) {
      event.preventDefault();
      const [dx, dy] = panKeys[event.key];
      commit(panBy(viewRef.current, dx, dy), true);
      return;
    }
    // "+" and "_" need Shift on most layouts, so Shift must not block zoom.
    if (event.shiftKey && event.key !== "+" && event.key !== "_") return;

    let target: string | null | undefined;
    switch (event.key) {
      case "ArrowUp":
        target = current?.parent;
        break;
      case "ArrowDown":
        target = current?.firstChild;
        break;
      case "ArrowLeft":
        target = current?.prev;
        break;
      case "ArrowRight":
        target = current?.next;
        break;
      case "Home":
        target = focus.firstRoot;
        break;
      case "End":
        target = focus.lastRoot;
        break;
      case "+":
      case "=":
        event.preventDefault();
        zoomFromCentre(ZOOM_STEP);
        return;
      case "-":
      case "_":
        event.preventDefault();
        zoomFromCentre(1 / ZOOM_STEP);
        return;
      case "0":
        event.preventDefault();
        fit();
        return;
      default:
        return;
    }
    event.preventDefault();
    if (target) focusNode(target);
  };

  const tabStop =
    activeId && focus.neighbours[activeId] ? activeId : focus.ids[0];
  const atMax = view.scale >= MAX_SCALE - 1e-9;
  const atMin = view.scale <= MIN_SCALE + 1e-9;

  return (
    <div className="flex flex-col gap-2">
      <div
        ref={viewportRef}
        className="relative h-[65dvh] min-h-80 cursor-grab touch-none overflow-hidden rounded-lg border bg-card select-none active:cursor-grabbing"
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerEnd}
        onPointerCancel={onPointerEnd}
      >
        <div
          role="tree"
          aria-label="Org Chart"
          aria-describedby={hintId}
          onKeyDown={onKeyDown}
          className={cn(
            "absolute top-0 left-0 origin-top-left",
            animated && "transition-transform duration-150 ease-out",
            "motion-reduce:transition-none",
            !ready && "invisible",
          )}
          style={{
            width: layout.width,
            height: layout.height,
            transform: `translate(${view.x}px, ${view.y}px) scale(${view.scale})`,
          }}
        >
          <svg
            aria-hidden="true"
            width={layout.width}
            height={layout.height}
            className="pointer-events-none absolute top-0 left-0 overflow-visible text-border forced-colors:text-[CanvasText]"
          >
            {layout.edges.map((edge) => {
              const from = placed.get(edge.fromId);
              const to = placed.get(edge.toId);
              if (!from || !to) return null;
              return (
                <path
                  key={`${edge.fromId}-${edge.toId}`}
                  d={edgePath(from, to, SIZES)}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth={2}
                />
              );
            })}
          </svg>
          {layout.nodes.map((node) => {
            const entry = info.get(node.id);
            const links = focus.neighbours[node.id];
            if (!entry || !links) return null;
            const { position } = entry;
            return (
              <div
                key={node.id}
                ref={(element) => {
                  if (element) nodeRefs.current.set(node.id, element);
                  else nodeRefs.current.delete(node.id);
                }}
                role="treeitem"
                aria-selected={false}
                aria-level={links.level}
                aria-posinset={links.position}
                aria-setsize={links.setSize}
                aria-label={accessibleName(entry)}
                data-node-id={node.id}
                tabIndex={node.id === tabStop ? 0 : -1}
                onFocus={() => onNodeFocus(node.id)}
                className={cn(
                  "absolute flex flex-col justify-center gap-1 overflow-hidden rounded-lg border bg-background px-3 py-2 text-card-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
                  position.isLeadership && "border-2 border-primary",
                )}
                style={{
                  left: node.x,
                  top: node.y,
                  width: SIZES.nodeWidth,
                  height: SIZES.nodeHeight,
                }}
              >
                <span
                  className="line-clamp-2 text-sm leading-snug font-medium"
                  title={position.name}
                >
                  {position.name}
                </span>
                {position.category || position.isLeadership ? (
                  <span className="flex items-center gap-2">
                    {position.category ? (
                      <span className="min-w-0 truncate text-xs text-muted-foreground">
                        {position.category}
                      </span>
                    ) : null}
                    {position.isLeadership ? (
                      <Badge variant="secondary" className="shrink-0">
                        Leadership
                      </Badge>
                    ) : null}
                  </span>
                ) : null}
              </div>
            );
          })}
        </div>

        <div
          className="absolute top-2 right-2 z-10 flex gap-1"
          onPointerDown={(event) => event.stopPropagation()}
        >
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            aria-label="Zoom in"
            disabled={atMax}
            onClick={() => zoomFromCentre(ZOOM_STEP)}
          >
            <ZoomIn aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            aria-label="Zoom out"
            disabled={atMin}
            onClick={() => zoomFromCentre(1 / ZOOM_STEP)}
          >
            <ZoomOut aria-hidden="true" />
          </Button>
          <Button
            type="button"
            variant="outline"
            size="icon"
            className="size-11"
            aria-label="Fit to view"
            onClick={fit}
          >
            <Maximize aria-hidden="true" />
          </Button>
        </div>
      </div>
      <p id={hintId} className="text-sm text-muted-foreground">
        Drag to pan. Scroll or pinch to zoom. Arrow keys move between positions,
        Shift with an arrow key pans, plus and minus zoom, 0 fits the chart.
      </p>
    </div>
  );
}
