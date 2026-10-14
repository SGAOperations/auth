import { describe, expect, it } from "vitest";
import {
  KEY_RETIREMENT_DAYS,
  isKeyRetirementActive,
  positionKeySchema,
  positionNameSchema,
} from "@/lib/position-key";

describe("positionKeySchema", () => {
  it.each(["vp-finance", "ab", "a1", "x-y-z", "9-lives", "a".repeat(64)])(
    "accepts %s",
    (key) => {
      expect(positionKeySchema.safeParse(key).success).toBe(true);
    },
  );

  it.each([
    ["uppercase", "VP-Finance"],
    ["too short", "a"],
    ["empty", ""],
    ["leading hyphen", "-x"],
    ["trailing hyphen", "x-"],
    ["double hyphen", "x--y"],
    ["underscore", "vp_finance"],
    ["space", "vp finance"],
    ["surrounding whitespace", " vp-finance "],
    ["too long", "a".repeat(65)],
  ])("rejects %s", (_label, key) => {
    expect(positionKeySchema.safeParse(key).success).toBe(false);
  });

  it("does not trim or lower-case the input", () => {
    const result = positionKeySchema.safeParse(" vp ");
    expect(result.success).toBe(false);
  });
});

describe("positionNameSchema", () => {
  it("trims surrounding whitespace", () => {
    expect(positionNameSchema.parse("  VP Finance  ")).toBe("VP Finance");
  });

  it("accepts the length boundaries", () => {
    expect(positionNameSchema.safeParse("ab").success).toBe(true);
    expect(positionNameSchema.safeParse("a".repeat(100)).success).toBe(true);
  });

  it("rejects names outside the length bounds", () => {
    expect(positionNameSchema.safeParse("a").success).toBe(false);
    expect(positionNameSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  it("rejects a name that is only whitespace", () => {
    expect(positionNameSchema.safeParse("     ").success).toBe(false);
  });

  it("measures length after trimming", () => {
    expect(positionNameSchema.safeParse(` a${" ".repeat(10)}`).success).toBe(
      false,
    );
  });
});

describe("isKeyRetirementActive", () => {
  const now = new Date("2026-10-14T12:00:00.000Z");
  const daysAgo = (days: number, extraMs = 0) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000 + extraMs);

  it("is active for a key retired just now", () => {
    expect(isKeyRetirementActive(now, now)).toBe(true);
  });

  it("is active for a key retired 100 days ago", () => {
    expect(isKeyRetirementActive(daysAgo(100), now)).toBe(true);
  });

  it("is active one millisecond inside the window", () => {
    expect(isKeyRetirementActive(daysAgo(KEY_RETIREMENT_DAYS, 1), now)).toBe(
      true,
    );
  });

  it("is reusable exactly 365 days after retirement", () => {
    expect(isKeyRetirementActive(daysAgo(KEY_RETIREMENT_DAYS), now)).toBe(
      false,
    );
  });

  it("is reusable 400 days after retirement", () => {
    expect(isKeyRetirementActive(daysAgo(400), now)).toBe(false);
  });
});
