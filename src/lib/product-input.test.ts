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

  for (const field of Object.keys(PRODUCT_CASES) as Array<
    keyof typeof PRODUCT_CASES
  >) {
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
      visibleToPositionKeys: ["vp-finance", "vp-finance", "president"],
    });
    expect(parsed.visibleToPositionKeys).toEqual(["vp-finance", "president"]);
  });

  it("rejects malformed position keys", () => {
    expect(
      productCreateSchema.safeParse({
        ...valid,
        visibleToPositionKeys: ["VP-Finance"],
      }).success,
    ).toBe(false);
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
});
