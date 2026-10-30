import { describe, expect, it } from "vitest";
import { parseStoredMotion, resolveMotion } from "./motion";

describe("parseStoredMotion", () => {
  it("accepts only the exact paused value", () => {
    expect(parseStoredMotion("paused")).toBe("paused");
    expect(parseStoredMotion("Paused")).toBeNull();
    expect(parseStoredMotion("")).toBeNull();
    expect(parseStoredMotion("animate")).toBeNull();
    expect(parseStoredMotion(null)).toBeNull();
  });
});

describe("resolveMotion", () => {
  it("animates by default", () => {
    expect(resolveMotion({ prefersReduced: false, stored: null })).toBe(
      "animate",
    );
  });

  it("stills when paused", () => {
    expect(resolveMotion({ prefersReduced: false, stored: "paused" })).toBe(
      "still",
    );
  });

  it("lets reduced motion win over everything", () => {
    expect(resolveMotion({ prefersReduced: true, stored: null })).toBe("still");
    expect(resolveMotion({ prefersReduced: true, stored: "paused" })).toBe(
      "still",
    );
  });
});
