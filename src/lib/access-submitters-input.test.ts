import { describe, expect, it } from "vitest";
import {
  MAX_SUBMITTER_POSITIONS,
  sameKeySet,
  submitterKeysInputSchema,
} from "./access-submitters-input";

describe("submitterKeysInputSchema", () => {
  it("de-duplicates and sorts the keys", () => {
    const parsed = submitterKeysInputSchema.parse({
      keys: ["vp-finance", "president", "vp-finance"],
    });
    expect(parsed.keys).toEqual(["president", "vp-finance"]);
  });

  it("accepts an empty list", () => {
    expect(submitterKeysInputSchema.parse({ keys: [] }).keys).toEqual([]);
  });

  it("rejects a key with a bad format", () => {
    for (const key of ["VP-Finance", "vp_finance", "-vp", "a", ""]) {
      expect(submitterKeysInputSchema.safeParse({ keys: [key] }).success).toBe(
        false,
      );
    }
  });

  it("rejects more than the maximum number of keys", () => {
    const keys = Array.from(
      { length: MAX_SUBMITTER_POSITIONS + 1 },
      (_, i) => `position-${i}`,
    );
    expect(submitterKeysInputSchema.safeParse({ keys }).success).toBe(false);
    expect(
      submitterKeysInputSchema.safeParse({
        keys: keys.slice(0, MAX_SUBMITTER_POSITIONS),
      }).success,
    ).toBe(true);
  });

  it("rejects an extra property", () => {
    expect(
      submitterKeysInputSchema.safeParse({ keys: [], extra: true }).success,
    ).toBe(false);
  });

  it("rejects a missing keys property", () => {
    expect(submitterKeysInputSchema.safeParse({}).success).toBe(false);
  });
});

describe("sameKeySet", () => {
  it("ignores order and repeats", () => {
    expect(sameKeySet(["a-b", "c-d"], ["c-d", "a-b", "a-b"])).toBe(true);
  });

  it("treats two empty lists as the same", () => {
    expect(sameKeySet([], [])).toBe(true);
  });

  it("tells a subset from the whole", () => {
    expect(sameKeySet(["a-b"], ["a-b", "c-d"])).toBe(false);
    expect(sameKeySet(["a-b", "c-d"], ["a-b"])).toBe(false);
    expect(sameKeySet(["a-b"], ["c-d"])).toBe(false);
  });
});
