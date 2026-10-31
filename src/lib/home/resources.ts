import { z } from "zod";

// Pure and client-safe: no database, no `server-only`. All home-page and
// leadership-page copy and links live here and nowhere else. A link with no
// source is `href: null` and renders "Link coming soon"; never invent a URL.

export interface ResourceItem {
  label: string;
  /** `null` until the operator supplies the link. */
  href: string | null;
  note?: string;
  /** Shown as a "Coming soon" badge instead of a link. */
  comingSoon?: boolean;
}

export interface ResourceGroup {
  id: string;
  title: string;
  intro?: string;
  items: ResourceItem[];
  steps?: string[];
}

export const GUIDE_SLUGS = ["aplio", "chambers", "vaultz", "website"] as const;

export type GuideSlug = (typeof GUIDE_SLUGS)[number];

export const guideSlugSchema = z.enum(GUIDE_SLUGS);

export interface ProductGuide {
  slug: GuideSlug;
  name: string;
  path: string;
  summary: string;
  groups: ResourceGroup[];
}

export const SGA_LINKS = {
  website: {
    label: "SGA website",
    href: "https://northeasternsga.com",
    note: "northeasternsga.com",
  },
  slack: {
    label: "SGA Slack",
    href: "https://join.slack.com/t/neusga/shared_invite/zt-2ssd0xo9z-YsyoenzojsgI1Q~jetb0Gg",
    note: "Join the SGA workspace.",
  },
} as const;

export const GENERAL_RESOURCES: ResourceGroup[] = [
  {
    id: "key-links",
    title: "Key links",
    items: [
      { label: "Account access form", href: null },
      { label: "Roster update form", href: null },
      { label: "SGA Office access request form, Curry 332", href: null },
      { label: "Website text changes doc", href: null },
      { label: "Content creation request form", href: null },
    ],
  },
  {
    id: "leadership",
    title: "Leadership",
    items: [
      { label: "Leadership Summit slides", href: null },
      { label: "Leadership Handbook", href: null, comingSoon: true },
      { label: "Advocacy project start guide", href: null },
    ],
  },
  {
    id: "media",
    title: "Media training",
    intro: "Tell the VP of External Affairs before you engage with media.",
    items: [
      {
        label: "Media training guidance",
        href: "https://tinyurl.com/SGAmediatraining",
      },
      { label: "SGA media training one-pager", href: null },
    ],
  },
  {
    id: "events",
    title: "Events",
    intro: "Start planning 6 to 7 weeks ahead.",
    items: [
      { label: "Event request form", href: null },
      { label: "Content creation request form", href: null },
    ],
    steps: [
      "Book a room (Chambers room request).",
      "Hold a planning meeting.",
      "Submit the Engage form and the Facilities Event Management form: 4 weeks out.",
      "Start promotion and send content requests: 3 weeks out.",
      "Make purchases: 3 weeks out.",
      "Confirm final details: 2 weeks out.",
      "Run the event.",
      "Wrap up.",
    ],
  },
  {
    id: "records",
    title: "Minutes and templates",
    items: [
      { label: "Meeting minutes tracker", href: null },
      { label: "Email signature templates", href: null },
    ],
  },
];

export const PRODUCT_GUIDES: Record<GuideSlug, ProductGuide> = {
  aplio: {
    slug: "aplio",
    name: "Aplio",
    path: "/guides/aplio",
    summary: "SGA's common application portal.",
    groups: [
      {
        id: "apply",
        title: "Apply",
        items: [
          {
            label: "Apply on Aplio",
            href: "https://apply.northeasternsga.com",
            note: "apply.northeasternsga.com",
          },
        ],
      },
      {
        id: "process",
        title: "Rules and process",
        intro:
          "Follow the common application portal rules when you post or review an application.",
        items: [],
        steps: [
          "Add an application to the portal.",
          "Review applications in the portal.",
        ],
      },
    ],
  },
  chambers: {
    slug: "chambers",
    name: "Chambers",
    path: "/guides/chambers",
    summary: "Room bookings and cancellations.",
    groups: [
      {
        id: "rooms",
        title: "Rooms",
        intro: "Book and cancel SGA rooms in Chambers.",
        items: [
          {
            label: "Open Chambers",
            href: "https://chambers.northeasternsga.com",
            note: "chambers.northeasternsga.com",
          },
        ],
      },
    ],
  },
  vaultz: {
    slug: "vaultz",
    name: "VaultZ",
    path: "/guides/vaultz",
    summary: "Budgets, purchasing and E-Board reimbursement.",
    groups: [
      {
        id: "budgets",
        title: "Budgets",
        items: [
          { label: "FY26 division budgets sheet", href: null },
          {
            label: "Candy budget",
            href: null,
            note: "Covers communal tabling candy and the President's Corner.",
          },
        ],
      },
      {
        id: "purchasing",
        title: "Purchasing",
        intro: "Purchases go through the VP of Operational Affairs.",
        items: [],
      },
      {
        id: "reimbursement",
        title: "E-Board reimbursement",
        items: [],
        steps: [
          "Set up your Concur account.",
          "Keep your receipts for SABO.",
          "Submit your reimbursement in Concur.",
        ],
      },
    ],
  },
  website: {
    slug: "website",
    name: "SGA website",
    path: "/guides/website",
    summary:
      "Requesting changes to northeasternsga.com, and who owns each page.",
    groups: [
      {
        id: "changes",
        title: "Requesting changes",
        items: [
          {
            label: "Website text changes doc",
            href: null,
            note: "For text changes.",
          },
          {
            label: "Website visual change / new page request form",
            href: null,
            note: "For visual changes and new pages.",
          },
        ],
      },
      {
        id: "ownership",
        title: "Who owns what",
        intro:
          "Each leader owns their committee or board pages. VPs own their division pages.",
        items: [],
      },
    ],
  },
};

/** The guide for a raw URL segment, or `null`. Input is parsed, then looked up. */
export function guideBySlug(raw: unknown): ProductGuide | null {
  const parsed = guideSlugSchema.safeParse(raw);
  return parsed.success ? PRODUCT_GUIDES[parsed.data] : null;
}

/** The guide for a registry product slug, or `null` when it has none. */
export function guideForProduct(productSlug: string): ProductGuide | null {
  return guideBySlug(productSlug);
}
