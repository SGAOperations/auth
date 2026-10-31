"use client";

import { useSyncExternalStore } from "react";
import { useMotionPreference } from "@/hooks/use-motion-preference";
import type { TreeLayout, TreeStrand } from "@/lib/home/tree";

// Glowing lines that wave down the left of the product explorer, one ending at
// each tile. The waving is SMIL `d` morphing between two curves that share
// their end points, so the tile ends stay fixed while the rest sways. Server
// HTML, reduced motion and "Pause motion" all render the still `rest` curves.
// See docs/DESIGN.md "Home: product explorer".

const noopSubscribe = () => () => {};

function useHydrated(): boolean {
  return useSyncExternalStore(
    noopSubscribe,
    () => true,
    () => false,
  );
}

function strandOpacity(strand: TreeStrand, selectedIndex: number | null) {
  if (strand.tileIndex === null) return 0.45;
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
  const selected =
    strand.tileIndex !== null && strand.tileIndex === selectedIndex;
  return (
    <path
      d={strand.rest}
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
    width: layout.width,
    height: layout.height,
    viewBox: `0 0 ${layout.width} ${layout.height}`,
    focusable: false,
    fill: "none",
  } as const;

  return (
    <div
      aria-hidden="true"
      className="pointer-events-none absolute top-0 left-0 [mask-image:linear-gradient(to_bottom,transparent,black_8%,black_92%,transparent)] forced-colors:hidden print:hidden"
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
