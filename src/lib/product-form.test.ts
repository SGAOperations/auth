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
import { productUpdateSchema } from "@/lib/product-input";

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

  it("never includes id, even when the values carry one", () => {
    const withId = { ...valid, id: "p1" } as ProductFormValues;
    for (const mode of ["create", "update"] as const) {
      expect(toProductPayload(withId, mode)).not.toHaveProperty("id");
    }
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

  it("drops keys that are not form fields, such as the row id", () => {
    const values = productToFormValues({
      ...valid,
      iconUrl: null,
      id: "p1",
    } as never);
    expect(values).not.toHaveProperty("id");
  });

  it("yields an update payload the strict update schema accepts", () => {
    const row = { ...valid, iconUrl: null, loginRedirectPath: null, id: "p1" };
    const payload = toProductPayload(
      productToFormValues(row as never),
      "update",
    );
    expect(payload).not.toHaveProperty("id");
    expect(productUpdateSchema.safeParse(payload).success).toBe(true);
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

  it("ignores a key that is not a form field instead of rejecting it", async () => {
    const stray = { ...valid, id: "p1" } as ProductFormValues;
    for (const mode of ["create", "update"] as const) {
      const result = await productFormResolver(mode)(stray, undefined, {
        fields: {},
        shouldUseNativeValidation: false,
      });
      expect(result.errors).toEqual({});
    }
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

describe("submitErrorMessage", () => {
  it("reads the form-level message, if any", () => {
    expect(submitErrorMessage({})).toBeUndefined();
    expect(
      submitErrorMessage({
        submit: { type: "validation", message: "Check the form and retry." },
      } as never),
    ).toBe("Check the form and retry.");
  });
});

describe("fieldMessages", () => {
  it("keeps the first message of known fields and drops the rest", () => {
    expect(fieldMessages({ baseUrl: ["bad", "worse"], nope: ["x"] })).toEqual([
      ["baseUrl", "bad"],
    ]);
  });
});
