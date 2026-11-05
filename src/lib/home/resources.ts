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

// One document, two rows: the Self comment doc and the Website text changes
// doc keep their own labels and notes and share this URL.
const WEBSITE_TEXT_DOC_HREF =
  "https://docs.google.com/document/d/1_BtUxCKoy4aSAUhTtcBXioXvBjeTnZdZXy3O0ubBbMA/edit";

// One form, two rows: the Office access request form and the SGA Office
// (Curry 332) access form.
const OFFICE_ACCESS_HREF = "https://forms.gle/NApzZh3Jtft1CYw28";

// Items that appear in more than one list are written once and referenced.
const FINANCIAL_ALLOCATION_SHEET: ResourceItem = {
  label: "Financial Allocation FY27 sheet",
  href: "https://docs.google.com/spreadsheets/d/1MCeuA3Jgps5v7O3Lg1BmryZQC97xoTzQGlxKNBBBARg/edit?gid=0#gid=0",
};

const WEBSITE_TEXT_CHANGES_DOC: ResourceItem = {
  label: "Website text changes doc",
  href: WEBSITE_TEXT_DOC_HREF,
  note: "For text changes.",
};

const WEBSITE_VISUAL_CHANGE_FORM: ResourceItem = {
  label: "Website visual change / new page request form",
  href: "https://docs.google.com/forms/d/e/1FAIpQLSeGfAufyxtPTCy72MKA8E-xBWq9kNTwWth33VvnPLr2T7e8Gg/viewform",
  note: "For visual changes and new pages.",
};

const CONTENT_CREATION_FORM: ResourceItem = {
  label: "Content creation request form",
  href: "https://docs.google.com/forms/d/e/1FAIpQLSfDyV6VQ-wK4QNyEpEnImKPpaLYgfgnCemAbOQ6ipR2bQ_OtA/viewform",
};

const APLIO_PROCESS_INTRO =
  "Follow the common application portal rules when you post or review an application.";

const APLIO_PROCESS_STEPS = [
  "Message the VP of Operational Affairs and the Executive Vice President before opening a position.",
  "The VP of Operational Affairs helps with the logistical creation of the position.",
  "The Executive Vice President must review the position before it can be opened to the public.",
  "Add an application to the portal.",
  "Review applications in the portal.",
];

const REIMBURSEMENT_STEPS = [
  "Set up your Concur account.",
  "Keep your receipts for SABO.",
  "Submit your reimbursement in Concur.",
];

export const GENERAL_RESOURCES: ResourceGroup[] = [
  {
    id: "operational-links",
    title: "Operational Links",
    items: [
      FINANCIAL_ALLOCATION_SHEET,
      WEBSITE_TEXT_CHANGES_DOC,
      CONTENT_CREATION_FORM,
      { label: "Office access request form", href: OFFICE_ACCESS_HREF },
      { label: "Self comment doc", href: WEBSITE_TEXT_DOC_HREF },
      {
        label: "SGA Slack invite",
        href: SGA_LINKS.slack.href,
        note: SGA_LINKS.slack.note,
      },
    ],
  },
  {
    id: "finances",
    title: "Finances",
    intro:
      "Purchases go through the VP of Operational Affairs. E-Board reimbursement goes through Concur, and you keep your receipts for SABO.",
    items: [],
    steps: REIMBURSEMENT_STEPS,
  },
  {
    id: "aplio",
    title: "Common Application Portal (Aplio)",
    intro: APLIO_PROCESS_INTRO,
    items: [],
    steps: APLIO_PROCESS_STEPS,
  },
  {
    id: "events",
    title: "Events",
    items: [CONTENT_CREATION_FORM],
  },
  {
    id: "events-media",
    title: "Events and media",
    intro:
      "Start planning 6 to 7 weeks ahead. Media training comes from External Affairs. Tell the VP of External Affairs before you engage with media.",
    items: [
      { label: "Event request form", href: null },
      {
        label: "Media training guidance",
        href: "https://tinyurl.com/SGAmediatraining",
        note: "tinyurl.com/SGAmediatraining",
      },
      {
        label: "SGA media training one-pager",
        href: "https://docs.google.com/document/d/1I7WYosOjQWQZmD-FosszjM8JkIvTqkKClDMZbBONk-4/edit?tab=t.0",
      },
    ],
    steps: [
      "Book a room (Chambers room request).",
      "Hold a planning meeting.",
      "Submit your event forms: 4 weeks out.",
      "Start promotion and send content requests: 3 weeks out.",
      "Make purchases: 3 weeks out.",
      "Confirm final details: 2 weeks out.",
      "Run the event.",
      "Wrap up.",
    ],
  },
  {
    id: "website",
    title: "Website changes",
    intro:
      "Each leader owns their committee or board pages. VPs own their division pages.",
    items: [WEBSITE_TEXT_CHANGES_DOC, WEBSITE_VISUAL_CHANGE_FORM],
  },
  {
    id: "leadership",
    title: "Leadership",
    items: [
      {
        label: "SGA Leadership Summit slides",
        href: "https://canva.link/dh05lflhw8fnmg0",
      },
      {
        label: "Advocacy project start guide",
        href: "https://docs.google.com/document/d/18zhiMQ94Yi51lxY-UhmbnEepf0XgW3E06JxRRZ6URx0/preview?usp=sharing",
      },
      { label: "Leadership Handbook", href: null, comingSoon: true },
    ],
  },
  {
    id: "records",
    title: "Minutes and templates",
    items: [
      {
        label: "Meeting minutes tracker sheet",
        href: "https://docs.google.com/spreadsheets/d/1QClskxoWKwttC4rW5wYvegjeUZ8374mAzdiFy2HoyP4/edit?gid=668936491#gid=668936491",
      },
      {
        label: "Email signature templates",
        href: "https://docs.google.com/document/d/1tflqeIVxa3W4qZwV7hNggNnv5diXB0nHsOf6RYGv1E0/edit?tab=t.0",
      },
    ],
  },
  {
    id: "office-access",
    title: "Office access",
    items: [
      {
        label: "SGA Office (Curry 332) access form",
        href: OFFICE_ACCESS_HREF,
      },
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
        id: "process",
        title: "Rules and process",
        intro: APLIO_PROCESS_INTRO,
        items: [],
        steps: APLIO_PROCESS_STEPS,
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
        items: [],
      },
      // PLACEHOLDER (#348): the operator writes the Chambers usage tutorial. Replace this item with the tutorial's intro and steps. Do not fill it in without the operator's text.
      {
        id: "tutorial",
        title: "How to use Chambers",
        items: [
          { label: "Chambers usage tutorial", href: null, comingSoon: true },
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
        items: [FINANCIAL_ALLOCATION_SHEET],
      },
      {
        id: "purchasing",
        title: "Purchasing",
        intro:
          "Purchases go through the VP of Operational Affairs. For an event, make your purchases 3 weeks out.",
        items: [],
      },
      {
        id: "reimbursement",
        title: "E-Board reimbursement",
        intro:
          "E-Board reimbursement goes through Concur, and you keep your receipts for SABO.",
        items: [],
        steps: REIMBURSEMENT_STEPS,
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
        items: [WEBSITE_TEXT_CHANGES_DOC, WEBSITE_VISUAL_CHANGE_FORM],
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
