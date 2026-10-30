import { describe, expect, it } from "vitest";
import { productCreateSchema, productUpdateSchema } from "./product-input";
import { PRODUCT_CASES } from "./product-schema-cases";

const valid = {
  slug: "sgauth",
  name: "SGAuth",
  baseUrl: "https://auth.northeasternsga.com",
};

describe("productCreateSchema", () => {
  it("applies defaults for omitted fields", () => {
    const parsed = productCreateSchema.parse(valid);
    expect(parsed.description).toBe("");
    expect(parsed.isActive).toBe(true);
    expect(parsed.sortOrder).toBe(0);
    expect(parsed.visibleToPositionKeys).toEqual([]);
  });

  it("trims name and description", () => {
    const parsed = productCreateSchema.parse({
      ...valid,
      name: "  SGAuth  ",
      description: "  hello  ",
    });
    expect(parsed.name).toBe("SGAuth");
    expect(parsed.description).toBe("hello");
  });

  it("rejects unknown fields", () => {
    expect(productCreateSchema.safeParse({ ...valid, extra: 1 }).success).toBe(
      false,
    );
  });

  for (const field of Object.keys(PRODUCT_CASES).filter(
    (key): key is Exclude<keyof typeof PRODUCT_CASES, "visibility"> =>
      key !== "visibility",
  )) {
    describe(field, () => {
      for (const value of PRODUCT_CASES[field].accepted) {
        it(`accepts ${JSON.stringify(value)}`, () => {
          expect(
            productCreateSchema.safeParse({ ...valid, [field]: value }).success,
          ).toBe(true);
        });
      }
      for (const value of PRODUCT_CASES[field].rejected) {
        it(`rejects ${JSON.stringify(value)}`, () => {
          expect(
            productCreateSchema.safeParse({ ...valid, [field]: value }).success,
          ).toBe(false);
        });
      }
    });
  }

  it("collapses duplicate position keys", () => {
    const parsed = productCreateSchema.parse({
      ...valid,
      visibility: "POSITIONS",
      visibleToPositionKeys: ["vp-finance", "vp-finance", "president"],
    });
    expect(parsed.visibleToPositionKeys).toEqual(["vp-finance", "president"]);
  });

  it("rejects malformed position keys", () => {
    expect(
      productCreateSchema.safeParse({
        ...valid,
        visibility: "POSITIONS",
        visibleToPositionKeys: ["VP-Finance"],
      }).success,
    ).toBe(false);
  });

  it("defaults visibility to UNSET", () => {
    expect(productCreateSchema.parse(valid).visibility).toBe("UNSET");
  });

  describe("visibility", () => {
    for (const [visibility, keys] of PRODUCT_CASES.visibility.accepted) {
      it(`accepts ${visibility} with ${keys.length} keys`, () => {
        expect(
          productCreateSchema.safeParse({
            ...valid,
            visibility,
            visibleToPositionKeys: keys,
          }).success,
        ).toBe(true);
      });
    }
    for (const [visibility, keys] of PRODUCT_CASES.visibility.rejected) {
      it(`rejects ${visibility} with ${keys.length} keys`, () => {
        const result = productCreateSchema.safeParse({
          ...valid,
          visibility,
          visibleToPositionKeys: keys,
        });
        expect(result.success).toBe(false);
        expect(result.error?.issues[0]?.path).toEqual([
          "visibleToPositionKeys",
        ]);
      });
    }

    it("rejects an unknown gate", () => {
      expect(
        productCreateSchema.safeParse({ ...valid, visibility: "ADMINS" })
          .success,
      ).toBe(false);
    });
  });
});

describe("productUpdateSchema", () => {
  it("rejects a slug", () => {
    expect(productUpdateSchema.safeParse({ slug: "x" }).success).toBe(false);
  });

  it("accepts a rename without applying create defaults", () => {
    const result = productUpdateSchema.safeParse({ name: "Renamed" });
    expect(result.success).toBe(true);
    expect(result.data).toEqual({ name: "Renamed" });
  });

  it("accepts a gate and its keys together", () => {
    expect(
      productUpdateSchema.safeParse({
        visibility: "POSITIONS",
        visibleToPositionKeys: ["senator"],
      }).success,
    ).toBe(true);
    expect(
      productUpdateSchema.safeParse({
        visibility: "LEADERSHIP",
        visibleToPositionKeys: [],
      }).success,
    ).toBe(true);
  });

  it("refuses a gate without its keys, and keys without their gate", () => {
    for (const body of [
      { visibility: "EVERYONE" },
      { visibleToPositionKeys: ["senator"] },
    ]) {
      const result = productUpdateSchema.safeParse(body);
      expect(result.success).toBe(false);
      expect(result.error?.issues[0]?.message).toBe(
        "Send visibility and visibleToPositionKeys together.",
      );
    }
  });

  it("refuses a broken gate and keys pair", () => {
    for (const [visibility, keys] of PRODUCT_CASES.visibility.rejected) {
      expect(
        productUpdateSchema.safeParse({
          visibility,
          visibleToPositionKeys: keys,
        }).success,
      ).toBe(false);
    }
  });
});
