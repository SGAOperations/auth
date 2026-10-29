import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  ProductError,
  createProduct,
  deleteProduct,
  getProductForAdmin,
  listProductsForAdmin,
  updateProduct,
} from "@/lib/product-admin";
import { createAdmin } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 10);
const slugPrefix = `t50-${rand}`;

function input(suffix: string, overrides: Record<string, unknown> = {}) {
  const slug = `${slugPrefix}-${suffix}`;
  return {
    slug,
    name: `Product ${suffix}`,
    baseUrl: `https://${slug}.northeasternsga.com`,
    ...overrides,
  };
}

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof ProductError) return err.code;
    throw err;
  }
  return null;
}

describe("product admin service", () => {
  let actorId: string;

  beforeAll(async () => {
    actorId = (await createAdmin()).id;
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: slugPrefix } },
    });
  });

  it("creates a product and reads it back with its creator", async () => {
    const created = await createProduct(input("create"), actorId);
    const row = await getProductForAdmin(created.id);
    expect(row).toMatchObject({
      slug: `${slugPrefix}-create`,
      createdById: actorId,
      isActive: true,
    });
    expect(
      (await listProductsForAdmin()).some((p) => p.id === created.id),
    ).toBe(true);
  });

  it("rejects a duplicate slug with SLUG_TAKEN", async () => {
    await createProduct(input("dup"), actorId);
    expect(
      await codeOf(
        createProduct(
          input("dup", {
            baseUrl: `https://${slugPrefix}-dup-two.northeasternsga.com`,
          }),
          actorId,
        ),
      ),
    ).toBe("SLUG_TAKEN");
  });

  it("reports field errors for invalid input", async () => {
    const error = await createProduct(
      input("bad", { baseUrl: "https://x.northeasternsga.com/" }),
      actorId,
    ).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ProductError);
    expect((error as ProductError).fieldErrors).toHaveProperty("baseUrl");
  });

  it("updates only the named field and keeps the slug", async () => {
    const created = await createProduct(input("update"), actorId);
    const { product, changed } = await updateProduct(created.id, {
      name: "Renamed",
    });
    expect(changed).toEqual(["name"]);
    expect(product.name).toBe("Renamed");
    expect(product.slug).toBe(created.slug);
  });

  it("writes nothing when the update changes nothing", async () => {
    const created = await createProduct(input("same"), actorId);
    const { changed } = await updateProduct(created.id, {
      name: created.name,
    });
    expect(changed).toEqual([]);
  });

  it("rejects an update that carries a slug", async () => {
    const created = await createProduct(input("slug"), actorId);
    expect(
      await codeOf(updateProduct(created.id, { slug: `${slugPrefix}-other` })),
    ).toBe("INVALID_INPUT");
  });

  it("reports NOT_FOUND for an unknown id", async () => {
    expect(
      await codeOf(
        updateProduct("0192ab3c-0000-7f60-8a1b-000000000001", { name: "Ab" }),
      ),
    ).toBe("NOT_FOUND");
  });

  it("refuses to delete an active product", async () => {
    const created = await createProduct(input("active"), actorId);
    expect(await codeOf(deleteProduct(created.id, created.slug))).toBe(
      "ACTIVE_PRODUCT",
    );
  });

  it("refuses a wrong confirmation, then deletes after deactivation", async () => {
    const created = await createProduct(input("delete"), actorId);
    await updateProduct(created.id, { isActive: false });
    expect(await codeOf(deleteProduct(created.id, "wrong"))).toBe(
      "CONFIRMATION_MISMATCH",
    );
    await deleteProduct(created.id, created.slug);
    expect(await getProductForAdmin(created.id)).toBeNull();
  });
});
