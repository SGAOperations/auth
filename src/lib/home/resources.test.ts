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
    expect([...new Set(slack)]).toEqual([SGA_LINKS.slack.href]);
  });
});

const allItems = allGroups.flatMap((group) => group.items);
const generalItems = GENERAL_RESOURCES.flatMap((group) => group.items);
const generalById = Object.fromEntries(
  GENERAL_RESOURCES.map((group) => [group.id, group]),
);
const labels = (group: ResourceGroup) => group.items.map((item) => item.label);
const hrefOf = (label: string) =>
  allItems.find((item) => item.label === label)?.href;

const EXPECTED_LABELS: Record<string, string[]> = {
  "operational-links": [
    "Financial Allocation FY27 sheet",
    "Website text changes doc",
    "Content creation request form",
    "Office access request form",
    "Self comment doc",
    "SGA Slack invite",
  ],
  finances: [],
  aplio: [],
  events: ["Content creation request form"],
  "events-media": [
    "Event request form",
    "Media training guidance",
    "SGA media training one-pager",
  ],
  website: [
    "Website text changes doc",
    "Website visual change / new page request form",
  ],
  leadership: [
    "SGA Leadership Summit slides",
    "Advocacy project start guide",
    "Leadership Handbook",
  ],
  records: ["Meeting minutes tracker sheet", "Email signature templates"],
  "office-access": ["SGA Office (Curry 332) access form"],
};

const SUPPLIED_HREFS = [
  "https://docs.google.com/spreadsheets/d/1MCeuA3Jgps5v7O3Lg1BmryZQC97xoTzQGlxKNBBBARg/edit?gid=0#gid=0",
  "https://docs.google.com/document/d/1I7WYosOjQWQZmD-FosszjM8JkIvTqkKClDMZbBONk-4/edit?tab=t.0",
  "https://docs.google.com/document/d/1_BtUxCKoy4aSAUhTtcBXioXvBjeTnZdZXy3O0ubBbMA/edit",
  "https://forms.gle/NApzZh3Jtft1CYw28",
  "https://docs.google.com/forms/d/e/1FAIpQLSeGfAufyxtPTCy72MKA8E-xBWq9kNTwWth33VvnPLr2T7e8Gg/viewform",
  "https://canva.link/dh05lflhw8fnmg0",
  "https://docs.google.com/document/d/18zhiMQ94Yi51lxY-UhmbnEepf0XgW3E06JxRRZ6URx0/preview?usp=sharing",
  "https://docs.google.com/forms/d/e/1FAIpQLSfDyV6VQ-wK4QNyEpEnImKPpaLYgfgnCemAbOQ6ipR2bQ_OtA/viewform",
  "https://docs.google.com/spreadsheets/d/1QClskxoWKwttC4rW5wYvegjeUZ8374mAzdiFy2HoyP4/edit?gid=668936491#gid=668936491",
  "https://docs.google.com/document/d/1tflqeIVxa3W4qZwV7hNggNnv5diXB0nHsOf6RYGv1E0/edit?tab=t.0",
];

describe("leadership resources content", () => {
  it("has the nine topics in order, starting with Operational Links", () => {
    expect(GENERAL_RESOURCES.map((group) => group.id)).toEqual(
      Object.keys(EXPECTED_LABELS),
    );
    expect(GENERAL_RESOURCES[0].title).toBe("Operational Links");
  });

  it("lists every expected entry in each topic", () => {
    for (const [id, expected] of Object.entries(EXPECTED_LABELS)) {
      expect(labels(generalById[id]), id).toEqual(expected);
    }
  });

  it("carries none of the struck entries", () => {
    const struck = [
      "Account access form",
      "Roster update form",
      "Engage form",
      "Facilities Event Management form",
      "Candy budget",
      "FY26 division budgets sheet",
      "Financial Allocation FY26 sheet",
    ];
    for (const item of allItems) {
      expect(struck).not.toContain(item.label);
    }
    const text = allGroups.flatMap((group) => [
      group.title,
      group.intro ?? "",
      ...(group.steps ?? []),
      ...group.items.flatMap((item) => [item.label, item.note ?? ""]),
    ]);
    for (const line of text) {
      expect(line).not.toMatch(/Engage|Facilities|Candy|candy|FY26/);
    }
  });

  it("marks only the Handbook and the Chambers tutorial as coming soon, with no href", () => {
    const soon = allItems.filter((item) => item.comingSoon);
    expect(soon.map((item) => item.label).sort()).toEqual([
      "Chambers usage tutorial",
      "Leadership Handbook",
    ]);
    for (const item of soon) expect(item.href).toBeNull();
  });

  it("gives one label one href, and shares the two documents' URLs", () => {
    const byLabel = new Map<string, string | null>();
    for (const item of allItems) {
      if (byLabel.has(item.label)) {
        expect(byLabel.get(item.label), item.label).toBe(item.href);
      }
      byLabel.set(item.label, item.href);
    }
    expect(hrefOf("Office access request form")).toBe(
      hrefOf("SGA Office (Curry 332) access form"),
    );
    expect(hrefOf("Self comment doc")).toBe(hrefOf("Website text changes doc"));
  });

  it("uses the operator's URLs verbatim", () => {
    const hrefs = new Set(allHrefs);
    for (const href of SUPPLIED_HREFS) expect(hrefs.has(href), href).toBe(true);
  });

  it("leaves only the Event request form, Handbook and Chambers tutorial without a URL", () => {
    const missing = allItems.filter((item) => item.href === null);
    expect([...new Set(missing.map((item) => item.label))].sort()).toEqual([
      "Chambers usage tutorial",
      "Event request form",
      "Leadership Handbook",
    ]);
  });

  it("repeats the VaultZ reimbursement steps under Finances, with no link rows", () => {
    const reimbursement = PRODUCT_GUIDES.vaultz.groups.find(
      (group) => group.id === "reimbursement",
    );
    expect(generalById.finances.steps).toEqual(reimbursement?.steps);
    expect(generalById.finances.items).toEqual([]);
  });

  it("gives Aplio the five steps in both places, with no link rows", () => {
    const guide = PRODUCT_GUIDES.aplio.groups;
    expect(guide.map((group) => group.id)).toEqual(["process"]);
    expect(guide[0].steps).toHaveLength(5);
    expect(guide[0].steps?.[0]).toBe(
      "Message the VP of Operational Affairs and the Executive Vice President before opening a position.",
    );
    expect(guide[0].steps?.[4]).toBe("Review applications in the portal.");
    expect(generalById.aplio.steps).toEqual(guide[0].steps);
    expect(generalById.aplio.items).toEqual([]);
  });

  it("gives Chambers a Rooms group with no links, then the tutorial placeholder", () => {
    const groups = PRODUCT_GUIDES.chambers.groups;
    expect(groups.map((group) => group.id)).toEqual(["rooms", "tutorial"]);
    expect(groups[0].items).toEqual([]);
  });

  it("never links the Aplio or Chambers hosts, or labels their old rows", () => {
    const items = [
      ...generalItems,
      ...PRODUCT_GUIDES.aplio.groups.flatMap((group) => group.items),
      ...PRODUCT_GUIDES.chambers.groups.flatMap((group) => group.items),
    ];
    for (const item of items) {
      if (item.href) {
        const host = new URL(item.href).hostname;
        expect(host).not.toBe("apply.northeasternsga.com");
        expect(host).not.toBe("chambers.northeasternsga.com");
      }
    }
    for (const item of generalItems) {
      expect(["Apply on Aplio", "Chambers room request"]).not.toContain(
        item.label,
      );
    }
  });

  it("gives VaultZ Budgets, Purchasing and reimbursement, with only the FY27 sheet under Budgets", () => {
    const groups = PRODUCT_GUIDES.vaultz.groups;
    expect(groups.map((group) => group.id)).toEqual([
      "budgets",
      "purchasing",
      "reimbursement",
    ]);
    expect(labels(groups[0])).toEqual(["Financial Allocation FY27 sheet"]);
  });

  it("gives Website changes two rows with different hrefs", () => {
    const [text, visual] = generalById.website.items;
    expect(generalById.website.items).toHaveLength(2);
    expect(text.label).toBe("Website text changes doc");
    expect(visual.label).toBe("Website visual change / new page request form");
    expect(text.href).not.toBe(visual.href);
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
