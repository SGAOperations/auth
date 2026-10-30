// Pure particle math for the backdrop. `random` is injected so tests are
// deterministic. No browser globals.

export interface Particle {
  x: number;
  y: number;
  /** Radius in px. */
  r: number;
  /** Base alpha before twinkle. */
  alpha: number;
  /** Velocity in px/s. */
  vx: number;
  vy: number;
  /** Horizontal sway amplitude in px and period in s. */
  swayAmp: number;
  swayPeriod: number;
  /** Twinkle phase in radians. */
  phase: number;
}

const MIN_COUNT = 24;
const MAX_COUNT = 110;
const AREA_PER_PARTICLE = 14000;
const MAX_DT = 0.1;
const WRAP_MARGIN = 2;

export function particleCount(width: number, height: number): number {
  const raw = Math.round((width * height) / AREA_PER_PARTICLE);
  return Math.min(MAX_COUNT, Math.max(MIN_COUNT, raw));
}

function between(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

export function createParticles(
  count: number,
  width: number,
  height: number,
  random: () => number,
): Particle[] {
  return Array.from({ length: count }, () => ({
    x: random() * width,
    y: random() * height,
    r: between(random, 0.4, 1.4),
    alpha: between(random, 0.12, 0.55),
    vx: between(random, -2, 2),
    vy: between(random, -10, -3),
    swayAmp: between(random, 4, 8),
    swayPeriod: between(random, 8, 16),
    phase: random() * Math.PI * 2,
  }));
}

function wrap(value: number, max: number): number {
  const span = max + WRAP_MARGIN * 2;
  const shifted = (((value + WRAP_MARGIN) % span) + span) % span;
  return shifted - WRAP_MARGIN;
}

/** Advances particles in place. `dt` is seconds, clamped to 0.1. */
export function stepParticles(
  particles: Particle[],
  dt: number,
  width: number,
  height: number,
): void {
  const step = Math.min(Math.max(dt, 0), MAX_DT);
  for (const p of particles) {
    p.x = wrap(p.x + p.vx * step, width);
    p.y = wrap(p.y + p.vy * step, height);
  }
}

/** Horizontal sway offset in px at `t` seconds. */
export function swayOffset(p: Particle, t: number): number {
  return p.swayAmp * Math.sin((Math.PI * 2 * t) / p.swayPeriod + p.phase);
}

/** Alpha at `t` seconds: the base alpha twinkling by up to 30%. */
export function twinkleAlpha(p: Particle, t: number): number {
  return p.alpha * (1 + 0.3 * Math.sin(t * 1.5 + p.phase));
}
