import { cn } from "@/lib/utils";

// Pure markup, so global-error can use it without providers. Geometry comes
// from --ray-x in globals.css (docs/DESIGN.md).
const stillOff = "motion-reduce:animate-none motion-still:animate-none";

function Ray({ side }: { side: "left" | "right" }) {
  return (
    <div
      className={cn(
        "absolute inset-y-0 w-px opacity-50 sm:opacity-100",
        side === "left" ? "left-[var(--ray-x)]" : "right-[var(--ray-x)]",
      )}
    >
      <div
        className="absolute inset-0 w-px"
        style={{
          backgroundImage:
            "linear-gradient(to bottom, transparent, var(--glow) 12%, var(--glow) 88%, transparent)",
        }}
      />
      <div
        className={cn(
          "absolute inset-y-0 -left-4 w-8 animate-ray-breathe bg-glow-faint blur-md",
          stillOff,
        )}
      />
      <div className="absolute inset-0 overflow-hidden">
        <div
          className={cn(
            "absolute top-0 -left-px h-40 w-[3px] animate-ray-pulse blur-[1px]",
            side === "right" && "[animation-delay:-4.5s]",
            stillOff,
          )}
          style={{
            backgroundImage:
              "linear-gradient(to bottom, transparent, var(--glow), transparent)",
          }}
        />
      </div>
    </div>
  );
}

export function LightRays() {
  return (
    <>
      <Ray side="left" />
      <Ray side="right" />
    </>
  );
}
