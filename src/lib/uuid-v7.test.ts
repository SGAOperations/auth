import { describe, expect, it } from "vitest";
import { uuidv7 } from "@/lib/uuid-v7";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe("uuidv7", () => {
  it("has the version 7 and variant 10 layout in lower case", () => {
    for (let i = 0; i < 100; i++) {
      expect(uuidv7()).toMatch(UUID_V7);
    }
  });

  it("encodes the given time in its first 48 bits", () => {
    const now = 1_760_000_000_123;
    const hex = uuidv7(now).replaceAll("-", "").slice(0, 12);
    expect(parseInt(hex, 16)).toBe(now);
  });

  it("defaults to the current time", () => {
    const before = Date.now();
    const hex = uuidv7().replaceAll("-", "").slice(0, 12);
    const stamped = parseInt(hex, 16);
    expect(stamped).toBeGreaterThanOrEqual(before);
    expect(stamped).toBeLessThanOrEqual(Date.now());
  });

  it("produces no duplicates", () => {
    const ids = new Set(Array.from({ length: 1000 }, () => uuidv7()));
    expect(ids.size).toBe(1000);
  });

  it("sorts later times after earlier ones", () => {
    const earlier = uuidv7(1_760_000_000_000);
    const later = uuidv7(1_760_000_000_001);
    expect(later > earlier).toBe(true);
  });
});
