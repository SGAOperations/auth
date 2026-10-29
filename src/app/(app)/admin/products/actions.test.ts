import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getCurrentUser: vi.fn(),
  limitRequest: vi.fn(),
  audit: vi.fn(),
  invalidateProductCache: vi.fn(),
  revalidatePath: vi.fn(),
  redirect: vi.fn(),
  createProduct: vi.fn(),
  updateProduct: vi.fn(),
  deleteProduct: vi.fn(),
}));

vi.mock("@/lib/auth/current-user", () => ({
  getCurrentUser: mocks.getCurrentUser,
}));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: mocks.limitRequest,
}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: mocks.audit,
  withAuditTransaction: (_client: unknown, fn: (tx: unknown) => unknown) =>
    fn({}),
}));
vi.mock("@/lib/products", () => ({
  invalidateProductCache: mocks.invalidateProductCache,
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("next/navigation", () => ({ redirect: mocks.redirect }));
vi.mock("@/lib/product-admin", async () => {
  const { ProductError } = await vi.importActual<
    typeof import("@/lib/product-admin")
  >("@/lib/product-admin");
  return {
    ProductError,
    createProduct: mocks.createProduct,
    updateProduct: mocks.updateProduct,
    deleteProduct: mocks.deleteProduct,
  };
});

import { ProductError } from "@/lib/product-admin";
import { createProduct, deleteProduct, updateProduct } from "./actions";

const ID = "0192ab3c-0000-7f60-8a1b-000000000001";
const admin = {
  id: "u1",
  isAdmin: true,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  twoFactorEnabled: true,
};
const product = { id: ID, slug: "test-tool" };

function serviceCalls() {
  return (
    mocks.createProduct.mock.calls.length +
    mocks.updateProduct.mock.calls.length +
    mocks.deleteProduct.mock.calls.length
  );
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.getCurrentUser.mockResolvedValue(admin);
  mocks.limitRequest.mockResolvedValue(null);
});

describe("the authorization ladder", () => {
  it.each([
    ["no session", null],
    ["a non-admin", { ...admin, isAdmin: false }],
    ["an inactive admin", { ...admin, status: "DEACTIVATED" }],
    ["an admin without MFA", { ...admin, twoFactorEnabled: false }],
  ])("returns FORBIDDEN for %s and calls nothing", async (_name, actor) => {
    mocks.getCurrentUser.mockResolvedValue(actor);
    expect(await createProduct({})).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await updateProduct(ID, {})).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(await deleteProduct(ID, "x")).toEqual({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(serviceCalls()).toBe(0);
    expect(mocks.limitRequest).not.toHaveBeenCalled();
  });

  it("returns RATE_LIMITED without calling the service", async () => {
    mocks.limitRequest.mockResolvedValue(new Response(null, { status: 429 }));
    expect(await createProduct({})).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
    expect(mocks.limitRequest).toHaveBeenCalledWith("adminMutation", "u1");
    expect(serviceCalls()).toBe(0);
  });
});

describe("createProduct", () => {
  it("returns INVALID_INPUT with field errors", async () => {
    mocks.createProduct.mockRejectedValue(
      new ProductError("INVALID_INPUT", "bad", { baseUrl: ["Base URL"] }),
    );
    expect(await createProduct({})).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      fieldErrors: { baseUrl: ["Base URL"] },
    });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.invalidateProductCache).not.toHaveBeenCalled();
  });

  it("maps SLUG_TAKEN", async () => {
    mocks.createProduct.mockRejectedValue(new ProductError("SLUG_TAKEN"));
    expect(await createProduct({})).toEqual({
      ok: false,
      code: "SLUG_TAKEN",
    });
  });

  it("audits once, then invalidates the registry once", async () => {
    mocks.createProduct.mockResolvedValue(product);
    expect(await createProduct({ name: "Test Tool" })).toEqual({
      ok: true,
      id: ID,
    });
    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith({
      type: "PRODUCT_CREATED",
      actorType: "USER",
      actorUserId: "u1",
      targetType: "PRODUCT",
      targetId: ID,
      metadata: { slug: "test-tool" },
    });
    expect(mocks.invalidateProductCache).toHaveBeenCalledTimes(1);
  });

  it("rethrows an unexpected error", async () => {
    mocks.createProduct.mockRejectedValue(new Error("connection reset"));
    await expect(createProduct({})).rejects.toThrow("connection reset");
  });
});

describe("updateProduct", () => {
  it("returns NOT_FOUND for an id that is not a UUID", async () => {
    expect(await updateProduct("nope", {})).toEqual({
      ok: false,
      code: "NOT_FOUND",
    });
    expect(serviceCalls()).toBe(0);
  });

  it("audits the changed field names and invalidates", async () => {
    mocks.updateProduct.mockResolvedValue({ product, changed: ["baseUrl"] });
    expect(await updateProduct(ID, { baseUrl: "x" })).toEqual({
      ok: true,
      id: ID,
    });
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PRODUCT_UPDATED",
        metadata: { slug: "test-tool", fields: ["baseUrl"] },
      }),
    );
    expect(mocks.invalidateProductCache).toHaveBeenCalledTimes(1);
  });

  it("neither audits nor invalidates when nothing changed", async () => {
    mocks.updateProduct.mockResolvedValue({ product, changed: [] });
    expect(await updateProduct(ID, {})).toEqual({ ok: true, unchanged: true });
    expect(mocks.audit).not.toHaveBeenCalled();
    expect(mocks.invalidateProductCache).not.toHaveBeenCalled();
  });
});

describe("deleteProduct", () => {
  it("maps ACTIVE_PRODUCT and does not redirect", async () => {
    mocks.deleteProduct.mockRejectedValue(new ProductError("ACTIVE_PRODUCT"));
    expect(await deleteProduct(ID, "test-tool")).toEqual({
      ok: false,
      code: "ACTIVE_PRODUCT",
    });
    expect(mocks.redirect).not.toHaveBeenCalled();
  });

  it("audits, invalidates, then redirects to the list", async () => {
    mocks.deleteProduct.mockResolvedValue(product);
    await deleteProduct(ID, "test-tool");
    expect(mocks.audit).toHaveBeenCalledWith(
      expect.objectContaining({
        type: "PRODUCT_DELETED",
        metadata: { slug: "test-tool" },
      }),
    );
    expect(mocks.invalidateProductCache).toHaveBeenCalledTimes(1);
    expect(mocks.redirect).toHaveBeenCalledWith("/admin/products");
  });
});
