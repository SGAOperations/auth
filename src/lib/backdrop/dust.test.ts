import { describe, expect, it } from "vitest";
import {
  createParticles,
  particleCount,
  stepParticles,
  swayOffset,
  twinkleAlpha,
  type Particle,
} from "./dust";

function sequence(values: number[]): () => number {
  let i = 0;
  return () => values[i++ % values.length];
}

describe("particleCount", () => {
  it("scales with area", () => {
    expect(particleCount(1400, 1000)).toBe(100);
  });

  it("clamps to the minimum and maximum", () => {
    expect(particleCount(100, 100)).toBe(24);
    expect(particleCount(3840, 2160)).toBe(110);
  });
});

describe("createParticles", () => {
  it("creates the requested count within bounds", () => {
    const ps = createParticles(50, 800, 600, Math.random);
    expect(ps).toHaveLength(50);
    for (const p of ps) {
      expect(p.x).toBeGreaterThanOrEqual(0);
      expect(p.x).toBeLessThanOrEqual(800);
      expect(p.y).toBeGreaterThanOrEqual(0);
      expect(p.y).toBeLessThanOrEqual(600);
      expect(p.r).toBeGreaterThanOrEqual(0.4);
      expect(p.r).toBeLessThanOrEqual(1.4);
      expect(p.alpha).toBeGreaterThanOrEqual(0.12);
      expect(p.alpha).toBeLessThanOrEqual(0.55);
      expect(p.vy).toBeLessThanOrEqual(-3);
      expect(p.vy).toBeGreaterThanOrEqual(-10);
      expect(Math.abs(p.vx)).toBeLessThanOrEqual(2);
      expect(p.swayAmp).toBeGreaterThanOrEqual(4);
      expect(p.swayAmp).toBeLessThanOrEqual(8);
      expect(p.swayPeriod).toBeGreaterThanOrEqual(8);
      expect(p.swayPeriod).toBeLessThanOrEqual(16);
    }
  });

  it("is deterministic for a fixed random source", () => {
    const a = createParticles(3, 100, 100, sequence([0.1, 0.5, 0.9]));
    const b = createParticles(3, 100, 100, sequence([0.1, 0.5, 0.9]));
    expect(a).toEqual(b);
  });
});

function particle(overrides: Partial<Particle>): Particle {
  return {
    x: 50,
    y: 50,
    r: 1,
    alpha: 0.5,
    vx: 0,
    vy: -10,
    swayAmp: 5,
    swayPeriod: 10,
    phase: 0,
    ...overrides,
  };
}

describe("stepParticles", () => {
  it("advances positions by velocity times dt", () => {
    const p = particle({ vx: 2, vy: -10 });
    stepParticles([p], 0.05, 100, 100);
    expect(p.x).toBeCloseTo(50.1);
    expect(p.y).toBeCloseTo(49.5);
  });

  it("clamps dt so a returning tab does not jump", () => {
    const p = particle({ vy: -10 });
    stepParticles([p], 30, 100, 100);
    expect(p.y).toBeCloseTo(49);
  });

  it("ignores negative dt", () => {
    const p = particle({ vy: -10 });
    stepParticles([p], -1, 100, 100);
    expect(p.y).toBe(50);
  });

  it("wraps top to bottom", () => {
    const p = particle({ y: -1.9, vy: -10 });
    stepParticles([p], 0.1, 100, 100);
    expect(p.y).toBeGreaterThan(90);
    expect(p.y).toBeLessThanOrEqual(102);
  });

  it("sways within its amplitude", () => {
    const p = particle({ swayAmp: 6, swayPeriod: 10, phase: 0 });
    expect(swayOffset(p, 0)).toBeCloseTo(0);
    expect(swayOffset(p, 2.5)).toBeCloseTo(6);
    expect(Math.abs(swayOffset(p, 7.3))).toBeLessThanOrEqual(6);
  });

  it("twinkles within 30% of the base alpha", () => {
    const p = particle({ alpha: 0.5, phase: 0 });
    for (const t of [0, 0.4, 1, 2.1, 5]) {
      const a = twinkleAlpha(p, t);
      expect(a).toBeGreaterThanOrEqual(0.5 * 0.7 - 1e-9);
      expect(a).toBeLessThanOrEqual(0.5 * 1.3 + 1e-9);
    }
  });

  it("wraps side to side", () => {
    const right = particle({ x: 101.9, vx: 2, vy: 0 });
    stepParticles([right], 0.1, 100, 100);
    expect(right.x).toBeLessThan(0);
    const left = particle({ x: -1.9, vx: -2, vy: 0 });
    stepParticles([left], 0.1, 100, 100);
    expect(left.x).toBeGreaterThan(99);
  });
});
