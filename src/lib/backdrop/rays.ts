// Pure ray specs and the wave path builder. `global-error` is a client component
// that renders LightRays, so this file has no browser globals and no
// `server-only`.

/** The tallest viewport a ray must cover, px (a rotated 4K display). */
export const RAY_COVER_PX = 4320;

export interface RaySpec {
  id: string;
  /** Horizontal offset from --ray-x, rem. Positive moves toward the centre. */
  offsetRem: number;
  /** Half the sideways travel of the wave, px. */
  amplitudePx: number;
  /** Vertical length of one full wave, px. */
  wavelengthPx: number;
  waveSeconds: number;
  opacity: number;
  /** Rendered only from 70rem up, where there is room beside the content. */
  wideOnly: boolean;
}

export const RAYS: readonly RaySpec[] = [
  {
    id: "primary",
    offsetRem: 0,
    amplitudePx: 4,
    wavelengthPx: 420,
    waveSeconds: 16,
    opacity: 1,
    wideOnly: false,
  },
  {
    id: "inner",
    offsetRem: 0.875,
    amplitudePx: 7,
    wavelengthPx: 300,
    waveSeconds: 12,
    opacity: 0.45,
    wideOnly: true,
  },
  {
    id: "outer",
    offsetRem: -1.25,
    amplitudePx: 10,
    wavelengthPx: 520,
    waveSeconds: 20,
    opacity: 0.3,
    wideOnly: true,
  },
];

/** The SVG width: the sway on both sides plus the 1px stroke. */
export function rayWidth(spec: RaySpec): number {
  return 2 * spec.amplitudePx + 2;
}

/** Whole wavelengths drawn: enough to cover RAY_COVER_PX plus one to loop. */
export function wavePeriods(spec: RaySpec): number {
  return Math.ceil(RAY_COVER_PX / spec.wavelengthPx) + 1;
}

/** The SVG height, and the y the path ends at. */
export function rayHeight(spec: RaySpec): number {
  return wavePeriods(spec) * spec.wavelengthPx;
}

/**
 * A line down the centre `c` that sways by `amplitudePx` each side, drawn as
 * one quadratic then smooth `T` half-periods. The path repeats every
 * wavelength, so translating it by exactly one wavelength loops seamlessly.
 */
export function wavePath(spec: RaySpec): string {
  const a = spec.amplitudePx;
  const l = spec.wavelengthPx;
  const c = a + 1;
  const parts = [`M ${c} 0`, `Q ${c + 2 * a} ${l / 4} ${c} ${l / 2}`];
  for (let half = 2; half <= 2 * wavePeriods(spec); half += 1) {
    parts.push(`T ${c} ${(half * l) / 2}`);
  }
  return parts.join(" ");
}
