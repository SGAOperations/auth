import { describe, expect, it } from "vitest";
import type { ToolProduct } from "@/lib/account/tools";
import { toHomeProducts } from "@/lib/home/products";

const OWN_ORIGIN = "https://auth.northeasternsga.com";

function tool(
  slug: string,
  name: string,
  overrides: Partial<ToolProduct> = {},
): ToolProduct {
  return {
    id: slug,
    slug,
    name,
    description: `${name} description`,
    baseUrl: `https://${slug}.northeasternsga.com`,
    iconUrl: null,
    isActive: true,
    visibility: "EVERYONE",
    visibleToPositionKeys: [],
    ...overrides,
  };
}

const tools = [
  tool("sgauth", "SGAuth"),
  tool("vaultz", "VaultZ"),
  tool("chambers", "Chambers"),
  tool("senateportal", "SenatePortal"),
];

const viewer = { isLeadership: false };

function iconSrcFor(iconUrl: string | null) {
  const [product] = toHomeProducts(
    [tool("vaultz", "VaultZ", { iconUrl })],
    viewer,
    OWN_ORIGIN,
  );
  return product.iconSrc;
}

describe("toHomeProducts", () => {
  it("drops SGAuth and keeps the order", () => {
    const slugs = toHomeProducts(tools, viewer, OWN_ORIGIN).map((p) => p.slug);
    expect(slugs).toEqual(["vaultz", "chambers", "senateportal"]);
  });

  it("uses the registry base URL for the link", () => {
    const [vaultz] = toHomeProducts(tools, viewer, OWN_ORIGIN);
    expect(vaultz.href).toBe("https://vaultz.northeasternsga.com/");
  });

  it("gives a non-leader no leadership content for any product", () => {
    for (const product of toHomeProducts(tools, viewer, OWN_ORIGIN)) {
      expect(product.leadership).toBeNull();
      expect(product.guidePath).toBeNull();
    }
  });

  it("gives a leader the guide for VaultZ and nothing for SenatePortal", () => {
    const byslug = Object.fromEntries(
      toHomeProducts(tools, { isLeadership: true }, OWN_ORIGIN).map((p) => [
        p.slug,
        p,
      ]),
    );
    expect(byslug.vaultz.guidePath).toBe("/guides/vaultz");
    expect(byslug.vaultz.leadership?.map((g) => g.id)).toEqual([
      "budgets",
      "purchasing",
      "reimbursement",
    ]);
    expect(byslug.senateportal.leadership).toBeNull();
    expect(byslug.senateportal.guidePath).toBeNull();
  });

  it("takes tone and letter from the map", () => {
    const byslug = Object.fromEntries(
      toHomeProducts(tools, viewer, OWN_ORIGIN).map((p) => [p.slug, p]),
    );
    expect(byslug.vaultz).toMatchObject({ tone: "violet", letter: "Z" });
    expect(byslug.chambers).toMatchObject({ tone: "blue", letter: "C" });
    expect(byslug.senateportal).toMatchObject({ tone: "red", letter: "S" });
  });

  it("falls back to neutral and the first letter for an unknown slug", () => {
    const [other] = toHomeProducts(
      [tool("budget-tool", "budget tool")],
      viewer,
      OWN_ORIGIN,
    );
    expect(other).toMatchObject({ tone: "neutral", letter: "B" });
  });

  it("does not read inherited keys as tiles", () => {
    const [other] = toHomeProducts(
      [tool("__proto__", "proto")],
      viewer,
      OWN_ORIGIN,
    );
    expect(other).toMatchObject({ tone: "neutral", letter: "P" });
  });
});

describe("toHomeProducts iconSrc", () => {
  it("is the path of an icon on the own origin", () => {
    expect(iconSrcFor(`${OWN_ORIGIN}/vaultz-logo.svg`)).toBe(
      "/vaultz-logo.svg",
    );
  });

  it("keeps the query string", () => {
    expect(iconSrcFor(`${OWN_ORIGIN}/vaultz-logo.svg?v=2`)).toBe(
      "/vaultz-logo.svg?v=2",
    );
  });

  it("is null when there is no icon", () => {
    expect(iconSrcFor(null)).toBeNull();
  });

  it("is null for a foreign origin", () => {
    expect(iconSrcFor("https://cdn.example.com/vaultz-logo.svg")).toBeNull();
  });

  it("is null for a malformed value", () => {
    expect(iconSrcFor("not a url")).toBeNull();
    expect(iconSrcFor("/vaultz-logo.svg")).toBeNull();
  });

  it("is null for a lookalike host", () => {
    expect(
      iconSrcFor("https://auth.northeasternsga.com.evil.example/x.svg"),
    ).toBeNull();
    expect(
      iconSrcFor("https://evil.example/@auth.northeasternsga.com"),
    ).toBeNull();
  });

  it("is null for a different port or scheme", () => {
    expect(
      iconSrcFor("https://auth.northeasternsga.com:8443/x.svg"),
    ).toBeNull();
    expect(iconSrcFor("http://auth.northeasternsga.com/x.svg")).toBeNull();
  });
});
