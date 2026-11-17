import { describe, expect, it } from "vitest";
import { positionHoldersBody } from "@/lib/position-holders";

describe("positionHoldersBody", () => {
  it("accepts one to twenty valid keys", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["comptroller"] }).success,
    ).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, i) => `position-${i}`);
    expect(positionHoldersBody.safeParse({ keys: twenty }).success).toBe(true);
  });

  it("accepts duplicate keys", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["comptroller", "comptroller"] })
        .success,
    ).toBe(true);
  });

  it("rejects no keys and more than twenty", () => {
    expect(positionHoldersBody.safeParse({ keys: [] }).success).toBe(false);
    const twentyOne = Array.from({ length: 21 }, (_, i) => `position-${i}`);
    expect(positionHoldersBody.safeParse({ keys: twentyOne }).success).toBe(
      false,
    );
  });

  it("rejects keys with upper case or spaces", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["VP Finance"] }).success,
    ).toBe(false);
    expect(
      positionHoldersBody.safeParse({ keys: ["Comptroller"] }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and a missing keys field", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["comptroller"], extra: 1 })
        .success,
    ).toBe(false);
    expect(positionHoldersBody.safeParse({}).success).toBe(false);
  });
});
