import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { buildAuthOptions } from "@/lib/auth/options";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { createProductRegistry } from "@/lib/product-registry";
import { loadActiveProducts } from "@/lib/products";
import { useFakeClock, type FakeClock } from "@/test/fake-clock";

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const CACHE_TTL_PLUS_ONE_MS = 60_001;

const rand = Math.random().toString(36).slice(2, 10);
const slugPrefix = `t56-${rand}`;

describe("product registry through Better Auth's origin check", () => {
  // The same registry code and options as production, over this file's own
  // database client. Date is faked, and the default `now = Date.now` follows.
  const registry = createProductRegistry({
    loadActiveProducts: () => loadActiveProducts(prisma),
    ownOrigin: BASE_URL,
    sgauthEnv: "dev",
    log: logger,
  });
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: registry.getTrustedOrigins,
      // Better Auth skips the Origin check under Vitest unless this is set
      // explicitly, which would leave the registry unconsulted.
      advanced: { disableOriginCheck: false },
    }),
  );

  const productOrigin = `https://${slugPrefix}.northeasternsga.com`;
  let clock: FakeClock;

  // The cookie header is what makes Better Auth enforce the Origin check.
  function post(origin: string) {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-out`, {
        method: "POST",
        headers: {
          origin,
          cookie: "unrelated=1",
          "content-type": "application/json",
        },
        body: "{}",
      }),
    );
  }

  async function expectInvalidOrigin(origin: string) {
    const response = await post(origin);
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "INVALID_ORIGIN" });
  }

  beforeEach(() => {
    clock = useFakeClock();
    registry.invalidate();
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: slugPrefix } },
    });
  });

  it("follows the registry within the cache TTL", async () => {
    await expectInvalidOrigin(productOrigin);

    const product = await prisma.product.create({
      data: { slug: slugPrefix, name: "T56", baseUrl: productOrigin },
    });
    // Still inside the 60 s window that began with the first request.
    await expectInvalidOrigin(productOrigin);

    clock.advance(CACHE_TTL_PLUS_ONE_MS);
    expect((await post(productOrigin)).status).toBe(200);

    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: false },
    });
    clock.advance(CACHE_TTL_PLUS_ONE_MS);
    await expectInvalidOrigin(productOrigin);

    await prisma.product.update({
      where: { id: product.id },
      data: { isActive: true },
    });
    registry.invalidate();
    expect((await post(productOrigin)).status).toBe(200);

    await prisma.product.delete({ where: { id: product.id } });
    registry.invalidate();
    await expectInvalidOrigin(productOrigin);
  });

  it("never trusts an unregistered origin", async () => {
    await expectInvalidOrigin("https://unregistered.northeasternsga.com");
  });

  it("loads only active products, ordered by sortOrder then slug", async () => {
    await prisma.product.createMany({
      data: [
        {
          slug: `${slugPrefix}-b`,
          name: "B",
          baseUrl: `https://${slugPrefix}-b.northeasternsga.com`,
          sortOrder: 2,
        },
        {
          slug: `${slugPrefix}-a`,
          name: "A",
          baseUrl: `https://${slugPrefix}-a.northeasternsga.com`,
          sortOrder: 2,
        },
        {
          slug: `${slugPrefix}-first`,
          name: "First",
          baseUrl: `https://${slugPrefix}-first.northeasternsga.com`,
          sortOrder: 1,
        },
        {
          slug: `${slugPrefix}-off`,
          name: "Off",
          baseUrl: `https://${slugPrefix}-off.northeasternsga.com`,
          isActive: false,
        },
      ],
    });

    const slugs = (await loadActiveProducts(prisma))
      .map((row) => row.slug)
      .filter((slug) => slug.startsWith(slugPrefix));
    expect(slugs).toEqual([
      `${slugPrefix}-first`,
      `${slugPrefix}-a`,
      `${slugPrefix}-b`,
    ]);
  });
});
