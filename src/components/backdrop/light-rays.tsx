import {
  RAYS,
  rayHeight,
  rayWidth,
  wavePath,
  type RaySpec,
} from "@/lib/backdrop/rays";
import { cn } from "@/lib/utils";

// Pure markup, so global-error can use it without providers. Each side has a
// primary ray and, from 70rem, two fainter ones, all waving down the page.
// Geometry comes from --ray-x in globals.css and src/lib/backdrop/rays.ts
// (docs/DESIGN.md).
const stillOff = "motion-reduce:animate-none motion-still:animate-none";

// Room either side of the line for the halo's blur, which the mask would clip.
const HALO_ROOM_PX = 16;

function Ray({ side, spec }: { side: "left" | "right"; spec: RaySpec }) {
  const height = rayHeight(spec);
  const width = rayWidth(spec);
  const edge = `calc(var(--ray-x) + ${spec.offsetRem}rem)`;
  const path = wavePath(spec);
  const svgProps = {
    "aria-hidden": true,
    focusable: false,
    width,
    height,
    viewBox: `0 0 ${width} ${height}`,
    fill: "none",
    className: "absolute top-0",
    style: { left: HALO_ROOM_PX },
  } as const;

  return (
    <div
      className={cn(
        "absolute inset-y-0 [mask-image:linear-gradient(to_bottom,transparent,black_12%,black_88%,transparent)]",
        side === "left" ? "-translate-x-1/2" : "translate-x-1/2",
        spec.wideOnly && "hidden min-[70rem]:block",
      )}
      style={{
        width: width + 2 * HALO_ROOM_PX,
        opacity: spec.opacity,
        ...(side === "left" ? { left: edge } : { right: edge }),
      }}
    >
      <div
        className={cn(
          "absolute inset-x-0 top-0 animate-ray-wave opacity-50 will-change-transform sm:opacity-100",
          stillOff,
        )}
        style={
          {
            height,
            "--wave": `${spec.wavelengthPx}px`,
            "--wave-seconds": `${spec.waveSeconds}s`,
            "--wave-delay": `${side === "right" ? -spec.waveSeconds / 2 : 0}s`,
          } as React.CSSProperties
        }
      >
        <svg
          {...svgProps}
          className={cn(
            svgProps.className,
            "animate-ray-breathe blur-md",
            stillOff,
          )}
        >
          <path
            d={path}
            stroke="var(--glow-muted)"
            strokeWidth={8}
            strokeLinecap="round"
          />
        </svg>
        <svg {...svgProps}>
          <path d={path} stroke="var(--glow)" strokeWidth={1} />
        </svg>
      </div>
    </div>
  );
}

export function LightRays() {
  return (
    <>
      {RAYS.map((spec) => (
        <Ray key={`left-${spec.id}`} side="left" spec={spec} />
      ))}
      {RAYS.map((spec) => (
        <Ray key={`right-${spec.id}`} side="right" spec={spec} />
      ))}
    </>
  );
}
