import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { PRODUCT_CASES } from "./product-schema-cases";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe.skipIf(!url)("product registry schema", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

  const rand = Math.random().toString(36).slice(2, 10);
  const prefix = `t14-${rand}`;
  const baseUrl = `https://${prefix}.northeasternsga.com`;
  let counter = 0;
  const nextSlug = () => `${prefix}-${counter++}`;

  const make = (data: Record<string, unknown> = {}) =>
    prisma.product.create({
      data: {
        slug: nextSlug(),
        name: "Test",
        baseUrl,
        ...data,
      },
    });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: prefix } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  it("stores a valid product with defaults", async () => {
    const product = await make({ slug: `${prefix}-valid` });
    const row = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(row.isActive).toBe(true);
    expect(row.sortOrder).toBe(0);
    expect(row.visibleToPositionKeys).toEqual([]);
    expect(row.id).toMatch(UUID_V7);
  });

  it("accepts every valid base URL", async () => {
    for (const value of PRODUCT_CASES.baseUrl.accepted) {
      await expect(make({ baseUrl: value })).resolves.toBeDefined();
    }
  });

  it("rejects every invalid base URL", async () => {
    for (const value of PRODUCT_CASES.baseUrl.rejected) {
      await expect(make({ baseUrl: value })).rejects.toThrow(
        /Product_baseUrl_check/,
      );
    }
  });

  it("checks iconUrl", async () => {
    for (const value of PRODUCT_CASES.iconUrl.accepted) {
      await expect(make({ iconUrl: value })).resolves.toBeDefined();
    }
    await expect(
      make({ iconUrl: "http://cdn.example.com/i.png" }),
    ).rejects.toThrow(/Product_iconUrl_check/);
  });

  it("checks loginRedirectPath", async () => {
    for (const value of PRODUCT_CASES.loginRedirectPath.accepted) {
      await expect(make({ loginRedirectPath: value })).resolves.toBeDefined();
    }
    for (const value of ["//evil.com", "/a b"]) {
      await expect(make({ loginRedirectPath: value })).rejects.toThrow(
        /Product_loginRedirectPath_check/,
      );
    }
  });

  it("rejects malformed slugs", async () => {
    for (const slug of ["Bad_Slug", "a"]) {
      await expect(make({ slug })).rejects.toThrow(/Product_slug_check/);
    }
  });

  it("enforces slug uniqueness", async () => {
    const slug = `${prefix}-dup`;
    await make({ slug });
    await expect(make({ slug })).rejects.toMatchObject({ code: "P2002" });
  });

  it("keeps the slug when the name changes", async () => {
    const product = await make();
    const updated = await prisma.product.update({
      where: { id: product.id },
      data: { name: "Renamed" },
    });
    expect(updated.name).toBe("Renamed");
    expect(updated.slug).toBe(product.slug);
  });

  it("makes the slug immutable", async () => {
    const product = await make();
    await expect(
      prisma.product.update({
        where: { id: product.id },
        data: { slug: `${prefix}-other` },
      }),
    ).rejects.toThrow(/product_slug_immutable/);
  });

  it("records createdById", async () => {
    const user = await prisma.user.create({
      data: { email: `t14-creator-${rand}@example.invalid`, name: "Creator" },
    });
    const product = await make({ createdById: user.id });
    const row = await prisma.product.findUniqueOrThrow({
      where: { id: product.id },
    });
    expect(row.createdById).toBe(user.id);
  });
});
