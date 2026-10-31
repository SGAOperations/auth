import { beforeEach, describe, expect, it, vi } from "vitest";

const { SGAUTH, PRODUCT } = vi.hoisted(() => ({
  SGAUTH: "https://auth.northeasternsga.com",
  PRODUCT: "https://vaultz.northeasternsga.com",
}));

const cookieStore = vi.hoisted(() => ({
  get: vi.fn<(name: string) => { value: string } | undefined>(),
  set: vi.fn(),
}));
const openRedirect = vi.hoisted(() => vi.fn<() => Promise<string | null>>());

vi.mock("next/headers", () => ({ cookies: async () => cookieStore }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/auth/settings", () => ({
  toAuthSettings: () => ({
    baseURL: SGAUTH,
    secret: "test-secret",
    sgauthEnv: "production",
  }),
}));
vi.mock("@/lib/products", () => ({
  isAllowedRedirect: (href: string) => new URL(href).origin === PRODUCT,
}));
vi.mock("@/lib/redirect/cookie", () => ({
  openRedirect,
  redirectCookieOptions: () => ({ name: "sgauth-redirect", path: "/" }),
}));

import { consumeRedirect, isResolvedRedirect } from "@/lib/redirect/consume";

describe("isResolvedRedirect", () => {
  beforeEach(() => {
    cookieStore.get.mockReset();
    cookieStore.set.mockReset();
    openRedirect.mockReset();
  });

  it("accepts the absolute URL consumeRedirect returns for a product", async () => {
    cookieStore.get.mockReturnValue({ value: "sealed" });
    openRedirect.mockResolvedValue(`${PRODUCT}/purchases/42#top`);

    const target = await consumeRedirect();

    expect(target).toBe(`${PRODUCT}/purchases/42`);
    expect(await isResolvedRedirect(target)).toBe(true);
  });

  it("accepts the absolute home fallback consumeRedirect returns", async () => {
    cookieStore.get.mockReturnValue(undefined);

    const target = await consumeRedirect();

    expect(target).toBe(`${SGAUTH}/`);
    expect(await isResolvedRedirect(target)).toBe(true);
  });

  it.each([
    "https://evil.com/",
    "//evil.com",
    "javascript:alert(1)",
    // Resolves to an absolute URL, so it is not itself a resolved value.
    "/",
    "/account",
    // Normalization changes it, so it is not a value consumeRedirect returned.
    `${PRODUCT}/purchases/42#top`,
  ])("refuses %j", async (target) => {
    expect(await isResolvedRedirect(target)).toBe(false);
  });
});
