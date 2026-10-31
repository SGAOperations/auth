import { describe, expect, it } from "vitest";
import {
  sortPositionsForDisplay,
  toolHref,
  toolLetter,
  visibleTools,
  type ToolProduct,
} from "./tools";

function product(
  slug: string,
  overrides: Partial<ToolProduct> = {},
): ToolProduct {
  return {
    id: slug,
    slug,
    name: slug,
    description: "",
    baseUrl: `https://${slug}.northeasternsga.com`,
    iconUrl: null,
    isActive: true,
    visibility: "EVERYONE",
    visibleToPositionKeys: [],
    ...overrides,
  };
}

const everyone = product("everyone");
const finance = product("finance", {
  visibility: "POSITIONS",
  visibleToPositionKeys: ["vp-finance"],
});
const senate = product("senate", {
  visibility: "POSITIONS",
  visibleToPositionKeys: ["senator"],
});
const leadershipOnly = product("leaders", { visibility: "LEADERSHIP" });
const notSet = product("not-set", { visibility: "UNSET" });
const slugs = (products: readonly ToolProduct[]) => products.map((p) => p.slug);

const viewer = (keys: string[] = [], isLeadership = false) => ({
  positionKeys: new Set(keys),
  isLeadership,
});

describe("visibleTools", () => {
  const all = [everyone, finance, senate, leadershipOnly, notSet];

  it("shows a user with no positions only the products open to everyone", () => {
    expect(slugs(visibleTools(all, viewer()))).toEqual(["everyone"]);
  });

  it("adds the products a held position unlocks, in input order", () => {
    expect(slugs(visibleTools(all, viewer(["vp-finance"])))).toEqual([
      "everyone",
      "finance",
    ]);
  });

  it("matches on any one key", () => {
    const either = product("either", {
      visibility: "POSITIONS",
      visibleToPositionKeys: ["senator", "vp-finance"],
    });
    expect(slugs(visibleTools([either], viewer(["vp-finance"])))).toEqual([
      "either",
    ]);
  });

  it("keeps a POSITIONS product hidden when no key matches", () => {
    expect(slugs(visibleTools([senate], viewer(["vp-finance"])))).toEqual([]);
  });

  it("shows a leadership viewer the LEADERSHIP product but never an UNSET one", () => {
    expect(slugs(visibleTools(all, viewer([], true)))).toEqual([
      "everyone",
      "leaders",
    ]);
  });

  it("hides a LEADERSHIP product from a non-leadership viewer", () => {
    expect(slugs(visibleTools([leadershipOnly], viewer(["senator"])))).toEqual(
      [],
    );
  });

  it("drops an inactive product", () => {
    expect(
      visibleTools([product("off", { isActive: false })], viewer()),
    ).toEqual([]);
  });

  it("drops a product whose base URL is not on the SGA domain", () => {
    expect(
      visibleTools(
        [product("evil", { baseUrl: "https://evil.example" })],
        viewer(),
      ),
    ).toEqual([]);
  });
});

describe("toolHref", () => {
  it("ends the origin with a slash", () => {
    expect(toolHref("https://fin.northeasternsga.com")).toBe(
      "https://fin.northeasternsga.com/",
    );
  });
});

describe("toolLetter", () => {
  it.each([
    ["finance", "F"],
    ["  senate", "S"],
    ["éclair", "É"],
    ["", "?"],
    ["   ", "?"],
  ])("%j gives %j", (name, letter) => {
    expect(toolLetter(name)).toBe(letter);
  });
});

describe("sortPositionsForDisplay", () => {
  it("sorts by name, then key, without mutating the input", () => {
    const input = [
      { key: "b-two", name: "Treasurer" },
      { key: "a-one", name: "Senator" },
      { key: "a-two", name: "Treasurer" },
    ];
    const snapshot = structuredClone(input);
    expect(sortPositionsForDisplay(input).map((p) => p.key)).toEqual([
      "a-one",
      "a-two",
      "b-two",
    ]);
    expect(input).toEqual(snapshot);
  });
});
