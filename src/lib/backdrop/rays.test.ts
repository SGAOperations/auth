import { describe, expect, it } from "vitest";
import {
  RAYS,
  RAY_COVER_PX,
  rayHeight,
  rayWidth,
  wavePath,
  wavePeriods,
} from "@/lib/backdrop/rays";

describe("RAYS", () => {
  it("has unique ids and exactly one always-on primary", () => {
    const ids = RAYS.map((ray) => ray.id);
    expect(new Set(ids).size).toBe(ids.length);
    const always = RAYS.filter((ray) => !ray.wideOnly);
    expect(always.map((ray) => ray.id)).toEqual(["primary"]);
  });

  // The home product tree roots its branches on `--ray-x`, so `--ray-gap` in
  // globals.css assumes the always-on primary ray is centred exactly there.
  it("centres the always-on primary ray on --ray-x", () => {
    const primary = RAYS.find((ray) => ray.id === "primary");
    expect(primary?.offsetRem).toBe(0);
    expect(primary?.wideOnly).toBe(false);
  });
});

describe("wavePath", () => {
  it.each(RAYS)(
    "starts with M and has one T per later half-period ($id)",
    (spec) => {
      const path = wavePath(spec);
      expect(path.startsWith("M ")).toBe(true);
      expect(path.match(/T/g)).toHaveLength(2 * wavePeriods(spec) - 1);
    },
  );

  it.each(RAYS)("sways about its centre line ($id)", (spec) => {
    const c = spec.amplitudePx + 1;
    const control = wavePath(spec).match(/Q (\S+) /);
    // The quadratic's control point sits 2A out, so the curve itself reaches A.
    expect(Number(control?.[1])).toBe(c + 2 * spec.amplitudePx);
    for (const match of wavePath(spec).matchAll(/T (\S+) (\S+)/g)) {
      expect(Number(match[1])).toBe(c);
    }
  });

  it.each(RAYS)("ends at the full height ($id)", (spec) => {
    const last = [...wavePath(spec).matchAll(/T \S+ (\S+)/g)].at(-1);
    expect(Number(last?.[1])).toBe(wavePeriods(spec) * spec.wavelengthPx);
    expect(rayHeight(spec)).toBe(wavePeriods(spec) * spec.wavelengthPx);
  });

  it.each(RAYS)("covers the viewport plus one loop ($id)", (spec) => {
    expect(rayHeight(spec) - spec.wavelengthPx).toBeGreaterThanOrEqual(
      RAY_COVER_PX,
    );
  });
});

describe("rayWidth", () => {
  it("is the sway on both sides plus the stroke", () => {
    expect(rayWidth(RAYS[0])).toBe(10);
  });
});
