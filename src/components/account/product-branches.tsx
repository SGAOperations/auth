import type { CSSProperties } from "react";
import { toolHref, toolLetter, type ToolProduct } from "@/lib/account/tools";
import { cn } from "@/lib/utils";

// The "Your SGA tools" section: each product is a node on a branch off the
// backdrop's light rays. Wide screens (>= 70rem) draw branches out to the real
// rays, so the arithmetic is coupled to globals.css: --branch-length is the gap
// between this column's max-w-3xl and the ray (--tools-half must match it).
// Narrower screens hang the same motif off a local trunk. See docs/DESIGN.md.

const MAX_STAGGER = 8;

// Shared by every branch: a 1px line and a bright junction dot.
const branchBase = cn(
  "before:absolute before:top-1/2 before:h-px before:animate-branch-grow before:bg-linear-to-r before:from-glow-muted before:to-transparent before:motion-reduce:animate-none",
  "group-focus-within:before:from-glow group-hover:before:from-glow",
  "after:absolute after:top-1/2 after:size-1.5 after:-translate-y-1/2 after:rounded-full after:bg-glow after:shadow-[0_0_12px_var(--glow)]",
);

// Narrow: a 1.5rem branch off the trunk at the list's left edge.
const branchNarrow =
  "before:right-full before:w-6 before:origin-left after:right-[calc(100%+1.5rem-0.1875rem)]";

// Wide: odd items branch left, even items branch right, to the nearer ray.
const branchWide = {
  left: "min-[70rem]:before:right-full min-[70rem]:before:w-[var(--branch-length)] min-[70rem]:before:origin-left min-[70rem]:after:right-[calc(100%+var(--branch-length)-0.1875rem)]",
  right:
    "min-[70rem]:before:right-auto min-[70rem]:before:left-full min-[70rem]:before:w-[var(--branch-length)] min-[70rem]:before:origin-right min-[70rem]:before:bg-linear-to-l min-[70rem]:after:right-auto min-[70rem]:after:left-[calc(100%+var(--branch-length)-0.1875rem)]",
} as const;

export function ProductBranches({ tools }: { tools: ToolProduct[] }) {
  return (
    <section aria-labelledby="tools-heading" className="flex flex-col gap-3">
      <div className="flex flex-col gap-1">
        <h2
          id="tools-heading"
          className="font-heading text-base leading-snug font-medium"
        >
          Your SGA tools
        </h2>
        <p className="text-sm text-muted-foreground">
          One sign-in works across every SGA tool.
        </p>
      </div>
      {tools.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No tools are available to you yet. Tools appear here when an admin
          gives you a position or opens a tool to everyone.
        </p>
      ) : (
        <ul className="relative grid gap-3 pl-6 before:absolute before:inset-y-3 before:left-0 before:w-px before:bg-glow-muted min-[70rem]:grid-cols-2 min-[70rem]:gap-x-6 min-[70rem]:gap-y-4 min-[70rem]:pl-0 min-[70rem]:before:hidden">
          {tools.map((tool, index) => (
            <li
              key={tool.id}
              style={{ "--i": Math.min(index, MAX_STAGGER) } as CSSProperties}
              className={cn(
                "group relative",
                branchBase,
                branchNarrow,
                index % 2 === 0 ? branchWide.left : branchWide.right,
              )}
            >
              <a
                href={toolHref(tool.baseUrl)}
                className="flex h-full animate-in items-start gap-3 rounded-xl bg-card/80 p-3 ring-1 ring-glow-faint backdrop-blur-sm transition-colors fill-mode-backwards outline-none [--tw-animation-delay:calc(var(--i)*90ms)] fade-in hover:bg-muted hover:ring-glow-muted focus-visible:ring-2 focus-visible:ring-ring motion-reduce:animate-none"
              >
                <span
                  aria-hidden="true"
                  className="flex size-9 shrink-0 items-center justify-center rounded-full font-semibold shadow-[0_0_14px_-4px_var(--glow)] ring-1 ring-glow-muted"
                >
                  {toolLetter(tool.name)}
                </span>
                <span className="min-w-0">
                  <span className="block font-medium break-words">
                    {tool.name}
                  </span>
                  <span className="line-clamp-2 block text-sm text-muted-foreground">
                    {tool.description}
                  </span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
