import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn() } }));

import { Prisma } from "@/generated/prisma/client";
import {
  ProductError,
  changedProductFields,
  toProductError,
} from "@/lib/product-admin";

const before = {
  name: "Test Tool",
  description: "",
  baseUrl: "https://test-tool.northeasternsga.com",
  iconUrl: null,
  isActive: true,
  sortOrder: 0,
  visibility: "POSITIONS" as const,
  visibleToPositionKeys: ["vp-finance", "president"],
  loginRedirectPath: null,
};

describe("changedProductFields", () => {
  it("ignores keys that are absent from the patch", () => {
    expect(changedProductFields(before, {})).toEqual([]);
  });

  it("treats reordered position keys as unchanged", () => {
    expect(
      changedProductFields(before, {
        visibleToPositionKeys: ["president", "vp-finance"],
      }),
    ).toEqual([]);
  });

  it("detects a different set of position keys", () => {
    expect(
      changedProductFields(before, { visibleToPositionKeys: ["president"] }),
    ).toEqual(["visibleToPositionKeys"]);
  });

  it("detects a visibility change, alone or with the keys", () => {
    expect(changedProductFields(before, { visibility: "POSITIONS" })).toEqual(
      [],
    );
    expect(changedProductFields(before, { visibility: "LEADERSHIP" })).toEqual([
      "visibility",
    ]);
    expect(
      changedProductFields(before, {
        visibility: "EVERYONE",
        visibleToPositionKeys: [],
      }),
    ).toEqual(["visibility", "visibleToPositionKeys"]);
  });

  it("detects isActive and baseUrl changes", () => {
    expect(
      changedProductFields(before, {
        isActive: false,
        baseUrl: "https://other.northeasternsga.com",
      }),
    ).toEqual(["baseUrl", "isActive"]);
  });

  it("treats an explicit null on a nullable field as a change from a value", () => {
    expect(
      changedProductFields(
        { ...before, iconUrl: "https://example.com/i.png" },
        { iconUrl: null },
      ),
    ).toEqual(["iconUrl"]);
    expect(changedProductFields(before, { iconUrl: null })).toEqual([]);
  });
});

describe("toProductError", () => {
  it("returns a ProductError unchanged", () => {
    const err = new ProductError("NOT_FOUND");
    expect(toProductError(err)).toBe(err);
  });

  it("maps a duplicate slug to SLUG_TAKEN", () => {
    const err = new Prisma.PrismaClientKnownRequestError("Unique failed", {
      code: "P2002",
      clientVersion: "7.10.0",
      meta: {
        driverAdapterError: {
          name: "DriverAdapterError",
          cause: { constraint: { index: "Product_slug_key" } },
        },
      },
    });
    expect(toProductError(err)?.code).toBe("SLUG_TAKEN");
  });

  it("maps a CHECK violation to INVALID_INPUT", () => {
    const err = new Error(
      'new row for relation "Product" violates check constraint "Product_baseUrl_check"',
    );
    expect(toProductError(err)?.code).toBe("INVALID_INPUT");
  });

  it("returns null for anything else", () => {
    expect(toProductError(new Error("connection reset"))).toBeNull();
    expect(toProductError("boom")).toBeNull();
  });
});
