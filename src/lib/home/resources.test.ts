import { describe, expect, it } from "vitest";
import {
  GENERAL_RESOURCES,
  GUIDE_SLUGS,
  PRODUCT_GUIDES,
  SGA_LINKS,
  guideBySlug,
  guideForProduct,
  type ResourceGroup,
} from "@/lib/home/resources";

const allGroups: ResourceGroup[] = [
  ...GENERAL_RESOURCES,
  ...Object.values(PRODUCT_GUIDES).flatMap((guide) => guide.groups),
];

const allHrefs = [
  ...Object.values(SGA_LINKS).map((link) => link.href),
  ...allGroups.flatMap((group) => group.items.map((item) => item.href)),
].filter((href): href is string => href !== null);

describe("resource links", () => {
  it("are all https URLs", () => {
    expect(allHrefs.length).toBeGreaterThan(0);
    for (const href of allHrefs) {
      expect(new URL(href).protocol).toBe("https:");
    }
  });

  it("point at Slack only for the SGA Slack link", () => {
    const slack = allHrefs.filter((href) => {
      const host = new URL(href).hostname;
      return host === "slack.com" || host.endsWith(".slack.com");
    });
    expect(slack).toEqual([SGA_LINKS.slack.href]);
  });
});

describe("resource structure", () => {
  it("keeps group ids unique within each list", () => {
    const lists = [
      GENERAL_RESOURCES,
      ...Object.values(PRODUCT_GUIDES).map((guide) => guide.groups),
    ];
    for (const list of lists) {
      const ids = list.map((group) => group.id);
      expect(new Set(ids).size).toBe(ids.length);
    }
  });

  it("gives each guide its slug-derived path and keys by GUIDE_SLUGS", () => {
    expect(Object.keys(PRODUCT_GUIDES).sort()).toEqual([...GUIDE_SLUGS].sort());
    for (const guide of Object.values(PRODUCT_GUIDES)) {
      expect(guide.path).toBe(`/guides/${guide.slug}`);
    }
  });
});

describe("guideBySlug", () => {
  it("finds a known guide", () => {
    expect(guideBySlug("vaultz")?.name).toBe("VaultZ");
  });

  it.each(["nope", undefined, "__proto__", "constructor", 7, ""])(
    "returns null for %j",
    (raw) => {
      expect(guideBySlug(raw)).toBeNull();
    },
  );
});

describe("guideForProduct", () => {
  it("returns the guide for a registry slug that has one", () => {
    expect(guideForProduct("aplio")?.path).toBe("/guides/aplio");
  });

  it("returns null for senateportal and unknown slugs", () => {
    expect(guideForProduct("senateportal")).toBeNull();
    expect(guideForProduct("sgauth")).toBeNull();
  });
});
