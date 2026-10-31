"use client";

import Link from "next/link";
import { useEffect, useRef, useState } from "react";
import { ProductTree } from "@/components/home/product-tree";
import { ResourceGroup } from "@/components/home/resource-list";
import { buttonVariants } from "@/components/ui/button";
import { useMotionPreference } from "@/hooks/use-motion-preference";
import type { HomeProduct, TileTone } from "@/lib/home/products";
import { treeLayout } from "@/lib/home/tree";
import { cn } from "@/lib/utils";

// Whole class names, because Tailwind cannot see a built-up one.
const TONE_BG: Record<TileTone, string> = {
  violet: "bg-tile-violet",
  blue: "bg-tile-blue",
  red: "bg-tile-red",
  green: "bg-tile-green",
  neutral: "bg-tile-neutral",
};

const TONE_BUTTON: Record<TileTone, string> = {
  violet: "bg-tile-violet text-tile-foreground hover:bg-tile-violet/85",
  blue: "bg-tile-blue text-tile-foreground hover:bg-tile-blue/85",
  red: "bg-tile-red text-tile-foreground hover:bg-tile-red/85",
  green: "bg-tile-green text-tile-foreground hover:bg-tile-green/85",
  neutral: "bg-tile-neutral text-tile-foreground hover:bg-tile-neutral/85",
};

const focusRing =
  "rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-ring";

// The 56px tile: the product's icon when it has a usable one, otherwise its
// letter. An icon that fails to load leaves a transparent tile with a
// crossed-out picture, and no letter. It is decorative: the button's text is
// the accessible name.
function ProductTileMark({
  tone,
  letter,
  iconSrc,
  dimmed,
}: {
  tone: TileTone;
  letter: string;
  iconSrc: string | null;
  dimmed: boolean;
}) {
  const [failed, setFailed] = useState(false);
  const image = useRef<HTMLImageElement>(null);

  // A load that failed before hydration never reached `onError`.
  useEffect(() => {
    const img = image.current;
    if (img && img.complete && img.naturalWidth === 0) setFailed(true);
  }, []);

  return (
    <span
      aria-hidden="true"
      className={cn(
        "flex size-14 shrink-0 items-center justify-center rounded-xl text-xl font-semibold ring-1 shadow-[0_0_18px_-6px_var(--glow)] ring-glow-faint transition-[opacity,filter] motion-reduce:transition-none",
        !failed && ["text-tile-foreground", TONE_BG[tone]],
        dimmed &&
          "opacity-40 saturate-50 group-hover:opacity-100 group-hover:saturate-100 group-focus-visible:opacity-100 group-focus-visible:saturate-100",
      )}
    >
      {iconSrc === null ? (
        letter
      ) : failed ? (
        <svg
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth={1.5}
          strokeLinecap="round"
          strokeLinejoin="round"
          focusable="false"
          className="size-6 text-muted-foreground"
        >
          <rect x="3" y="3" width="18" height="18" rx="2" />
          <circle cx="8.5" cy="8.5" r="1.5" />
          <path d="m21 15-5-5L5 21" />
          <path d="M3 3l18 18" />
        </svg>
      ) : (
        // A same-origin SVG already at tile size: nothing for the image
        // optimizer to do.
        // eslint-disable-next-line @next/next/no-img-element
        <img
          ref={image}
          src={iconSrc}
          alt=""
          onError={() => setFailed(true)}
          className="size-full rounded-[inherit] object-contain"
        />
      )}
    </span>
  );
}

// The product explorer: a column of tiles with branches growing to them from
// the backdrop ray, a divider, and a panel for the selected tool. Selection is
// a group of toggle buttons (`aria-pressed`), not ARIA tabs. The Tailwind
// spacing on the tile list (`pt-10 gap-5 pl-[5.5rem]`) must equal PAD_Y,
// ROW_GAP and TREE_WIDTH in src/lib/home/tree.ts, or the branches miss the
// tiles. See docs/DESIGN.md.
export function ProductExplorer({ products }: { products: HomeProduct[] }) {
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null);
  const panel = useRef<HTMLElement>(null);
  const { motion } = useMotionPreference();
  const layout = treeLayout(products.length);

  const selectedIndex = products.findIndex((p) => p.slug === selectedSlug);
  const selected = selectedIndex === -1 ? null : products[selectedIndex];

  function toggle(slug: string) {
    if (slug === selectedSlug) {
      setSelectedSlug(null);
      return;
    }
    setSelectedSlug(slug);
    // Below md the panel sits under the tiles; bring it into view without
    // moving focus off the tile.
    if (window.matchMedia("(width < 48rem)").matches) {
      panel.current?.scrollIntoView({
        block: "nearest",
        behavior: motion === "animate" ? "smooth" : "auto",
      });
    }
  }

  return (
    <div className="grid gap-6 md:grid-cols-[minmax(0,20rem)_1px_minmax(0,1fr)] md:gap-8">
      <div className="relative" style={{ minHeight: layout.height }}>
        <ProductTree
          layout={layout}
          selectedIndex={selected ? selectedIndex : null}
        />
        <ul className="relative flex flex-col gap-5 pt-10 pl-[5.5rem]">
          {products.map((product) => {
            const isSelected = product.slug === selected?.slug;
            const dimmed = selected !== null && !isSelected;
            return (
              <li key={product.slug}>
                <button
                  type="button"
                  aria-pressed={isSelected}
                  aria-controls="product-panel"
                  onClick={() => toggle(product.slug)}
                  className="group flex h-14 w-full items-center gap-3 rounded-xl pr-2 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring"
                >
                  <ProductTileMark
                    key={product.iconSrc ?? "none"}
                    tone={product.tone}
                    letter={product.letter}
                    iconSrc={product.iconSrc}
                    dimmed={dimmed}
                  />
                  <span
                    className={cn(
                      "line-clamp-2 min-w-0 font-medium break-words transition-colors motion-reduce:transition-none",
                      dimmed &&
                        "text-muted-foreground group-hover:text-foreground group-focus-visible:text-foreground",
                    )}
                  >
                    {product.name}
                  </span>
                </button>
              </li>
            );
          })}
        </ul>
      </div>

      <div
        aria-hidden="true"
        className="hidden w-px self-stretch bg-glow-muted md:block"
      />

      <section
        ref={panel}
        id="product-panel"
        aria-label="Tool details"
        className="border-t border-glow-faint pt-6 md:border-t-0 md:pt-0"
      >
        <div
          key={selected?.slug ?? "none"}
          className="flex animate-in flex-col gap-4 duration-300 fade-in motion-reduce:animate-none"
        >
          {selected ? (
            <>
              <h3 className="text-xl font-semibold tracking-tight break-words">
                {selected.name}
              </h3>
              <a
                href={selected.href}
                className={cn(
                  buttonVariants({ variant: "secondary", size: "lg" }),
                  "w-fit",
                  TONE_BUTTON[selected.tone],
                )}
              >
                Go to {selected.name}
              </a>
              {selected.description ? (
                <p className="text-base">{selected.description}</p>
              ) : null}
              {selected.leadership ? (
                <div className="flex flex-col gap-4 border-t border-glow-faint pt-4">
                  <h4 className="font-heading text-base font-medium">
                    Leadership information
                  </h4>
                  {selected.leadership.map((group) => (
                    <ResourceGroup
                      key={group.id}
                      group={group}
                      headingLevel={5}
                      variant="plain"
                    />
                  ))}
                  {selected.guidePath ? (
                    <Link
                      href={selected.guidePath}
                      className={cn(
                        "inline-flex min-h-11 w-fit items-center underline-offset-4 hover:underline",
                        focusRing,
                      )}
                    >
                      Open the full {selected.name} guide
                    </Link>
                  ) : null}
                </div>
              ) : null}
            </>
          ) : (
            <p className="text-muted-foreground">
              Choose a tool to see what it&apos;s for and open it.
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
