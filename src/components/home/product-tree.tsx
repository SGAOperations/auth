"use client";

import { useSyncExternalStore } from "react";
import { useMotionPreference } from "@/hooks/use-motion-preference";
import { TREE_WIDTH, type TreeLayout, type TreeStrand } from "@/lib/home/tree";

// One glowing branch per tile, growing out of the backdrop's primary left ray
// and ending on the tile's left edge. The SVG starts at the ray (`--ray-gap`
// left of the tile column) and is stretched to span it, hence
// `preserveAspectRatio="none"` and non-scaling strokes. The swaying is SMIL `d`
// morphing between two curves that share their end points, so the ray root and
// the tile tip stay fixed. Server HTML, reduced motion and "Pause motion" all
// render the still `rest` curves. See docs/DESIGN.md "Home: product explorer".

const noopSubscribe = () => () => {};

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function strandOpacity(strand: TreeStrand, selectedIndex: number | null) {
  if (selectedIndex === null) return 0.8;
  return strand.tileIndex === selectedIndex ? 1 : 0.25;
}

function StrandPath({
  strand,
  selectedIndex,
  animate,
  halo,
}: {
  strand: TreeStrand;
  selectedIndex: number | null;
  animate: boolean;
  halo: boolean;
}) {
  const selected = strand.tileIndex === selectedIndex;
  return (
    <path
      d={strand.rest}
      vectorEffect="non-scaling-stroke"
      stroke={halo ? "var(--glow-muted)" : "var(--glow)"}
      strokeWidth={halo ? 6 : selected ? 2.5 : 2}
      strokeLinecap="round"
      style={{ opacity: strandOpacity(strand, selectedIndex) }}
      className="transition-opacity duration-300 motion-reduce:transition-none"
    >
      {animate ? (
        <animate
          attributeName="d"
          values={`${strand.rest};${strand.peak};${strand.rest}`}
          keyTimes="0;0.5;1"
          calcMode="spline"
          keySplines="0.45 0 0.55 1;0.45 0 0.55 1"
          dur={`${strand.seconds}s`}
          begin={`-${strand.delaySeconds}s`}
          repeatCount="indefinite"
        />
      ) : null}
    </path>
  );
}

export function ProductTree({
  layout,
  selectedIndex,
}: {
  layout: TreeLayout;
  selectedIndex: number | null;
}) {
  const hydrated = useHydrated();
  const { motion } = useMotionPreference();
  const animate = hydrated && motion === "animate";
  const svgProps = {
    width: "100%",
    height: layout.height,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    preserveAspectRatio: "none",
    focusable: false,
    fill: "none",
  } as const;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 forced-colors:hidden print:hidden"
      style={{
        left: "calc(-1 * var(--ray-gap))",
        width: `calc(var(--ray-gap) + ${TREE_WIDTH}px)`,
        height: layout.height,
      }}
    >
      <svg {...svgProps} className="absolute top-0 left-0 blur-[3px]">
        {layout.strands.map((strand) => (
          <StrandPath
            key={strand.id}
            strand={strand}
            selectedIndex={selectedIndex}
            animate={animate}
            halo
          />
        ))}
      </svg>
      <svg {...svgProps} className="relative block">
        {layout.strands.map((strand) => (
          <StrandPath
            key={strand.id}
            strand={strand}
            selectedIndex={selectedIndex}
            animate={animate}
            halo={false}
          />
        ))}
      </svg>
    </div>
  );
}
