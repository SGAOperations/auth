import { describe, expect, it } from "vitest";
import {
  PRODUCT_FORM_DEFAULTS,
  fieldMessages,
  productFormResolver,
  productToFormValues,
  submitErrorMessage,
  suggestProductSlug,
  toProductPayload,
  type ProductFormValues,
} from "@/lib/product-form";

const valid: ProductFormValues = {
  ...PRODUCT_FORM_DEFAULTS,
  slug: "test-tool",
  name: "Test Tool",
  baseUrl: "https://test-tool.northeasternsga.com",
};

describe("suggestProductSlug", () => {
  it("folds diacritics and collapses punctuation", () => {
    expect(suggestProductSlug("Café Ops  Hub!")).toBe("cafe-ops-hub");
  });

  it("cuts to 64 characters without a trailing hyphen", () => {
    const slug = suggestProductSlug(`${"a".repeat(63)} bbbbbb`);
    expect(slug.length).toBeLessThanOrEqual(64);
    expect(slug.endsWith("-")).toBe(false);
  });

  it("returns an empty slug when nothing is usable", () => {
    expect(suggestProductSlug("  !!  ")).toBe("");
  });
});

describe("toProductPayload", () => {
  it("maps blank optional text to null", () => {
    expect(toProductPayload(valid, "create")).toMatchObject({
      iconUrl: null,
      loginRedirectPath: null,
    });
  });

  it("passes everything else through unchanged", () => {
    const values = {
      ...valid,
      iconUrl: "https://example.com/i.png",
      loginRedirectPath: "/home",
      sortOrder: 3,
    };
    expect(toProductPayload(values, "create")).toEqual(values);
  });

  it("sends the ticked positions only under Specific positions", () => {
    const ticked = { ...valid, visibleToPositionKeys: ["senator"] };
    expect(
      toProductPayload({ ...ticked, visibility: "POSITIONS" }, "update")
        .visibleToPositionKeys,
    ).toEqual(["senator"]);
    for (const visibility of ["EVERYONE", "LEADERSHIP", "UNSET"] as const) {
      expect(
        toProductPayload({ ...ticked, visibility }, "update")
          .visibleToPositionKeys,
      ).toEqual([]);
    }
  });

  it("drops the slug in update mode", () => {
    expect(toProductPayload(valid, "update")).not.toHaveProperty("slug");
  });
});

describe("productToFormValues", () => {
  it("turns null optional text into blanks", () => {
    const values = productToFormValues({
      ...valid,
      iconUrl: null,
      loginRedirectPath: null,
    });
    expect(values.iconUrl).toBe("");
    expect(values.loginRedirectPath).toBe("");
  });
});

describe("productFormResolver", () => {
  it("accepts a valid create form", async () => {
    const result = await productFormResolver("create")(valid, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result.errors).toEqual({});
  });

  it("reports a trailing slash on the base URL", async () => {
    const result = await productFormResolver("create")(
      { ...valid, baseUrl: "https://test-tool.northeasternsga.com/" },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(result.errors.baseUrl?.message).toContain("Base URL");
  });

  it("asks for a position when Specific positions has none", async () => {
    const result = await productFormResolver("update")(
      { ...valid, visibility: "POSITIONS", visibleToPositionKeys: [] },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(result.errors.visibleToPositionKeys?.message).toBe(
      "Choose at least one position.",
    );
  });

  it("accepts stale ticks under another gate, since they are not sent", async () => {
    const result = await productFormResolver("update")(
      { ...valid, visibility: "EVERYONE", visibleToPositionKeys: ["senator"] },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(result.errors).toEqual({});
  });

  it("blocks the submit with a form-level error when no issue names a form field", async () => {
    // Defensive: no typed form value reaches this, since every schema issue
    // path maps to a form field. A stray key stands in, as the strict schemas
    // report it with an empty path.
    const stray = { ...valid, stray: true } as ProductFormValues;
    const result = await productFormResolver("create")(stray, undefined, {
      fields: {},
      shouldUseNativeValidation: false,
    });
    expect(result.values).toEqual({});
    expect(Object.keys(result.errors)).not.toEqual([]);
    expect(submitErrorMessage(result.errors)).toBeTruthy();
  });

  it("does not require a slug in update mode", async () => {
    const result = await productFormResolver("update")(
      { ...valid, slug: "" },
      undefined,
      { fields: {}, shouldUseNativeValidation: false },
    );
    expect(result.errors).toEqual({});
  });
});

describe("fieldMessages", () => {
  it("keeps the first message of known fields and drops the rest", () => {
    expect(fieldMessages({ baseUrl: ["bad", "worse"], nope: ["x"] })).toEqual([
      ["baseUrl", "bad"],
    ]);
  });
});
