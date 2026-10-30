import { describe, expect, it } from "vitest";
import type { ToolProduct } from "@/lib/account/tools";
import { toHomeProducts } from "@/lib/home/products";

function tool(slug: string, name: string): ToolProduct {
  return {
    id: slug,
    slug,
    name,
    description: `${name} description`,
    baseUrl: `https://${slug}.northeasternsga.com`,
    isActive: true,
    visibility: "EVERYONE",
    visibleToPositionKeys: [],
  };
}

const tools = [
  tool("sgauth", "SGAuth"),
  tool("vaultz", "VaultZ"),
  tool("chambers", "Chambers"),
  tool("senateportal", "SenatePortal"),
];

describe("toHomeProducts", () => {
  it("drops SGAuth and keeps the order", () => {
    const slugs = toHomeProducts(tools, { isLeadership: false }).map(
      (p) => p.slug,
    );
    expect(slugs).toEqual(["vaultz", "chambers", "senateportal"]);
  });

  it("uses the registry base URL for the link", () => {
    const [vaultz] = toHomeProducts(tools, { isLeadership: false });
    expect(vaultz.href).toBe("https://vaultz.northeasternsga.com/");
  });

  it("gives a non-leader no leadership content for any product", () => {
    for (const product of toHomeProducts(tools, { isLeadership: false })) {
      expect(product.leadership).toBeNull();
      expect(product.guidePath).toBeNull();
    }
  });

  it("gives a leader the guide for VaultZ and nothing for SenatePortal", () => {
    const byslug = Object.fromEntries(
      toHomeProducts(tools, { isLeadership: true }).map((p) => [p.slug, p]),
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
      toHomeProducts(tools, { isLeadership: false }).map((p) => [p.slug, p]),
    );
    expect(byslug.vaultz).toMatchObject({ tone: "violet", letter: "Z" });
    expect(byslug.chambers).toMatchObject({ tone: "blue", letter: "C" });
    expect(byslug.senateportal).toMatchObject({ tone: "red", letter: "S" });
  });

  it("falls back to neutral and the first letter for an unknown slug", () => {
    const [other] = toHomeProducts([tool("budget-tool", "budget tool")], {
      isLeadership: false,
    });
    expect(other).toMatchObject({ tone: "neutral", letter: "B" });
  });

  it("does not read inherited keys as tiles", () => {
    const [other] = toHomeProducts([tool("__proto__", "proto")], {
      isLeadership: false,
    });
    expect(other).toMatchObject({ tone: "neutral", letter: "P" });
  });
});
