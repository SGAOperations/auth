import { describe, expect, it } from "vitest";
import {
  PRODUCT_VISIBILITIES,
  PRODUCT_VISIBILITY_COPY,
  canViewProduct,
  visibilityKeysIssue,
  visibilitySummary,
  type ProductViewer,
} from "./product-visibility";

const senator: ProductViewer = {
  positionKeys: new Set(["senator"]),
  isLeadership: false,
};
const leader: ProductViewer = {
  positionKeys: new Set(["executive-vice-president"]),
  isLeadership: true,
};
const nobody: ProductViewer = { positionKeys: new Set(), isLeadership: false };

describe("canViewProduct", () => {
  it("shows an EVERYONE product to any viewer", () => {
    const product = {
      visibility: "EVERYONE",
      visibleToPositionKeys: [],
    } as const;
    expect(canViewProduct(product, nobody)).toBe(true);
    expect(canViewProduct(product, senator)).toBe(true);
  });

  it("shows a LEADERSHIP product only to leadership", () => {
    const product = {
      visibility: "LEADERSHIP",
      visibleToPositionKeys: [],
    } as const;
    expect(canViewProduct(product, leader)).toBe(true);
    expect(canViewProduct(product, senator)).toBe(false);
    expect(canViewProduct(product, nobody)).toBe(false);
  });

  it("shows a POSITIONS product to a holder of any listed key", () => {
    const product = {
      visibility: "POSITIONS",
      visibleToPositionKeys: ["senator", "parliamentarian"],
    } as const;
    expect(canViewProduct(product, senator)).toBe(true);
    expect(canViewProduct(product, leader)).toBe(false);
    expect(canViewProduct(product, nobody)).toBe(false);
  });

  it("fails closed for POSITIONS with no keys", () => {
    const product = {
      visibility: "POSITIONS",
      visibleToPositionKeys: [],
    } as const;
    expect(canViewProduct(product, leader)).toBe(false);
  });

  it("hides an UNSET product from everyone", () => {
    const product = { visibility: "UNSET", visibleToPositionKeys: [] } as const;
    expect(canViewProduct(product, leader)).toBe(false);
    expect(canViewProduct(product, senator)).toBe(false);
  });
});

describe("visibilityKeysIssue", () => {
  it("requires a key for POSITIONS", () => {
    expect(visibilityKeysIssue("POSITIONS", [])).toBe(
      "Choose at least one position.",
    );
    expect(visibilityKeysIssue("POSITIONS", ["senator"])).toBeNull();
  });

  it.each(["EVERYONE", "LEADERSHIP", "UNSET"] as const)(
    "refuses keys under %s",
    (visibility) => {
      expect(visibilityKeysIssue(visibility, ["senator"])).toBe(
        "Positions apply only to Specific positions.",
      );
      expect(visibilityKeysIssue(visibility, [])).toBeNull();
    },
  );
});

describe("visibilitySummary", () => {
  it("names each gate", () => {
    expect(
      visibilitySummary({ visibility: "EVERYONE", visibleToPositionKeys: [] }),
    ).toBe("Anyone signed in");
    expect(
      visibilitySummary({
        visibility: "LEADERSHIP",
        visibleToPositionKeys: [],
      }),
    ).toBe("Leadership");
    expect(
      visibilitySummary({ visibility: "UNSET", visibleToPositionKeys: [] }),
    ).toBe("Not set yet");
  });

  it("counts positions", () => {
    expect(
      visibilitySummary({
        visibility: "POSITIONS",
        visibleToPositionKeys: ["a-b"],
      }),
    ).toBe("1 position");
    expect(
      visibilitySummary({
        visibility: "POSITIONS",
        visibleToPositionKeys: ["a-b", "c-d", "e-f"],
      }),
    ).toBe("3 positions");
  });
});

describe("PRODUCT_VISIBILITY_COPY", () => {
  it("has a label and description for every gate", () => {
    for (const visibility of PRODUCT_VISIBILITIES) {
      expect(PRODUCT_VISIBILITY_COPY[visibility].label).not.toBe("");
      expect(PRODUCT_VISIBILITY_COPY[visibility].description).not.toBe("");
    }
  });
});
