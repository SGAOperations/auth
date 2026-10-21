import { z } from "zod";
import { formatDuration, formatEt, renderLayout } from "./layout";

// Pure on purpose, like layout.ts: no `server-only`, no env. Each template is a
// zod schema plus a render function. Paragraph strings are built here from
// data and escaped once, in the layout.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

const name = z.string().trim().min(1).max(100).optional();

const url = z.url({ protocol: /^https?$/ });

const expiresInMinutes = z.number().int().positive();

function greeting(recipient?: string): string {
  return recipient ? `Hi ${recipient},` : "Hi,";
}

function defineTemplate<S extends z.ZodType>(template: {
  schema: S;
  /** Data fields that hold URLs. The mailer checks their origin. */
  links: readonly string[];
  render: (data: z.infer<S>) => EmailContent;
}) {
  return template;
}

function compose(
  subject: string,
  layout: Parameters<typeof renderLayout>[0],
): EmailContent {
  return { subject, ...renderLayout(layout) };
}

const REASON_LINES = {
  cancelled: () => "The Primary Admin transfer was cancelled.",
  declined: (other: string) =>
    `The Primary Admin transfer was declined by ${other}.`,
  expired: () => "The Primary Admin transfer expired before it was accepted.",
  "recipient-ineligible": (other: string) =>
    `The Primary Admin transfer was cancelled because ${other} is no longer an eligible admin.`,
} as const;

const SECURITY_EVENTS = {
  "password-changed": {
    subject: "Your SGA Auth password was changed",
    heading: "Your password was changed",
  },
  "password-reset": {
    subject: "Your SGA Auth password was reset",
    heading: "Your password was reset",
  },
  "admin-granted": {
    subject: "You now have admin access in SGA Auth",
    heading: "You now have admin access",
  },
} as const;

export const TEMPLATES = {
  "verify-email": defineTemplate({
    schema: z.object({ name, url, expiresInMinutes }),
    links: ["url"],
    render: (d) =>
      compose("Verify your email for SGA Auth", {
        preheader: "Confirm this address to finish creating your account.",
        heading: "Verify your email",
        paragraphs: [
          greeting(d.name),
          `Confirm this address to finish creating your SGA account. The link expires in ${formatDuration(d.expiresInMinutes)}.`,
        ],
        action: { label: "Verify email", url: d.url },
        afterAction: [
          "If you didn't create an account, you can ignore this email.",
        ],
      }),
  }),

  "reset-password": defineTemplate({
    schema: z.object({ name, url, expiresInMinutes }),
    links: ["url"],
    render: (d) =>
      compose("Reset your SGA Auth password", {
        preheader: "Choose a new password for your SGA account.",
        heading: "Reset your password",
        paragraphs: [
          greeting(d.name),
          `Someone asked to reset the password for this account. The link works once and expires in ${formatDuration(d.expiresInMinutes)}.`,
        ],
        action: { label: "Choose a new password", url: d.url },
        afterAction: [
          "If you didn't ask for this, ignore this email. Your password won't change.",
        ],
      }),
  }),

  "set-password": defineTemplate({
    schema: z.object({
      name,
      url,
      expiresInMinutes,
      kind: z.enum(["first-sign-in", "admin-invite"]),
    }),
    links: ["url"],
    render: (d) => {
      const invite = d.kind === "admin-invite";
      return compose(
        invite
          ? "You've been invited to SGA Auth"
          : "Set your SGA Auth password",
        {
          preheader: "Set a password to finish setting up your account.",
          heading: invite ? "You've been invited" : "Set your password",
          paragraphs: [
            greeting(d.name),
            ...(invite ? ["An SGA admin set up an account for you."] : []),
            "Your account is ready, but it has no password yet.",
            `The link expires in ${formatDuration(d.expiresInMinutes)}.`,
          ],
          action: { label: "Set password", url: d.url },
        },
      );
    },
  }),

  "account-locked": defineTemplate({
    schema: z.object({ name, lockedUntil: z.date() }),
    links: [],
    render: (d) =>
      compose("Your SGA account was locked", {
        preheader: "Sign-in to your account is locked for now.",
        heading: "Your account was locked",
        paragraphs: [
          greeting(d.name),
          `We locked sign-in to your account after repeated failed attempts. It unlocks automatically at ${formatEt(d.lockedUntil)}, or use the unlock link we sent separately. If this wasn't you, reset your password.`,
        ],
      }),
  }),

  "account-unlock": defineTemplate({
    schema: z.object({ name, url, expiresInMinutes }),
    links: ["url"],
    render: (d) =>
      compose("Unlock your SGA account", {
        preheader: "Use this link to unlock your account.",
        heading: "Unlock your account",
        paragraphs: [
          greeting(d.name),
          `Use this link to unlock your SGA account. The link works once and expires in ${formatDuration(d.expiresInMinutes)}.`,
        ],
        action: { label: "Unlock account", url: d.url },
      }),
  }),

  "security-notice": defineTemplate({
    schema: z.object({
      name,
      event: z.enum(["password-changed", "password-reset", "admin-granted"]),
      occurredAt: z.date(),
    }),
    links: [],
    render: (d) => {
      const event = SECURITY_EVENTS[d.event];
      return compose(event.subject, {
        preheader: event.heading,
        heading: event.heading,
        paragraphs: [
          greeting(d.name),
          `This happened at ${formatEt(d.occurredAt)}. If this wasn't you, reset your password right away and contact SGA.`,
        ],
      });
    },
  }),

  "pa-transfer-initiated": defineTemplate({
    schema: z.discriminatedUnion("role", [
      z.object({
        role: z.literal("recipient"),
        url,
        fromName: z.string().trim().min(1).max(100),
        acceptBy: z.date(),
      }),
      z.object({
        role: z.literal("initiator"),
        toName: z.string().trim().min(1).max(100),
        acceptBy: z.date(),
      }),
    ]),
    links: ["url"],
    render: (d) =>
      d.role === "recipient"
        ? compose(`${d.fromName} wants to make you Primary Admin of SGA Auth`, {
            preheader: "Review a Primary Admin transfer.",
            heading: "Primary Admin transfer request",
            paragraphs: [
              greeting(),
              `${d.fromName} wants to make you Primary Admin of SGA Auth.`,
              `Accept by ${formatEt(d.acceptBy)}.`,
            ],
            action: { label: "Review transfer", url: d.url },
          })
        : compose(`You started a Primary Admin transfer to ${d.toName}`, {
            preheader: "Your Primary Admin transfer is waiting for a response.",
            heading: "Primary Admin transfer started",
            paragraphs: [
              greeting(),
              `You started a Primary Admin transfer to ${d.toName}.`,
              `It goes ahead only if they accept by ${formatEt(d.acceptBy)}.`,
            ],
          }),
  }),

  "pa-transfer-accepted": defineTemplate({
    schema: z.discriminatedUnion("role", [
      z.object({
        role: z.literal("initiator"),
        cancelUrl: url,
        toName: z.string().trim().min(1).max(100),
        executesAt: z.date(),
      }),
      z.object({
        role: z.literal("recipient"),
        fromName: z.string().trim().min(1).max(100),
        executesAt: z.date(),
      }),
    ]),
    links: ["cancelUrl"],
    render: (d) =>
      d.role === "initiator"
        ? compose("Primary Admin transfer accepted", {
            preheader: `${d.toName} accepted the transfer.`,
            heading: "Primary Admin transfer accepted",
            paragraphs: [
              greeting(),
              `${d.toName} accepted. The transfer completes at ${formatEt(d.executesAt)}.`,
              "You can cancel until then.",
            ],
            action: { label: "Cancel transfer", url: d.cancelUrl },
          })
        : compose("Primary Admin transfer accepted", {
            preheader: "You are about to become Primary Admin.",
            heading: "Primary Admin transfer accepted",
            paragraphs: [
              greeting(),
              `You'll become Primary Admin at ${formatEt(d.executesAt)}.`,
              `${d.fromName} can cancel the transfer until then.`,
            ],
          }),
  }),

  "pa-transfer-cancelled": defineTemplate({
    schema: z.object({
      role: z.enum(["initiator", "recipient"]),
      otherName: z.string().trim().min(1).max(100),
      reason: z.enum([
        "cancelled",
        "declined",
        "expired",
        "recipient-ineligible",
      ]),
    }),
    links: [],
    render: (d) =>
      compose("Primary Admin transfer cancelled", {
        preheader: "A Primary Admin transfer will not go ahead.",
        heading: "Primary Admin transfer cancelled",
        paragraphs: [
          greeting(),
          REASON_LINES[d.reason](d.otherName),
          "Nothing changed: the current Primary Admin keeps the role.",
        ],
      }),
  }),

  "pa-transfer-completed": defineTemplate({
    schema: z.object({
      role: z.enum(["initiator", "recipient", "admin"]),
      fromName: z.string().trim().min(1).max(100),
      toName: z.string().trim().min(1).max(100),
      completedAt: z.date(),
    }),
    links: [],
    render: (d) =>
      compose(`${d.toName} is now Primary Admin of SGA Auth`, {
        preheader: `${d.toName} is now Primary Admin.`,
        heading: "Primary Admin transfer complete",
        paragraphs: [
          greeting(),
          `${d.fromName} transferred the Primary Admin role to ${d.toName} at ${formatEt(d.completedAt)}.`,
          ...(d.role === "admin" ? [] : ["You'll need to sign in again."]),
        ],
      }),
  }),

  "inactivity-notice": defineTemplate({
    schema: z.object({
      name,
      lastLoginAt: z.date(),
      deleteAfter: z.date(),
      signInUrl: url,
    }),
    links: ["signInUrl"],
    render: (d) =>
      compose("Sign in to keep your SGA account", {
        preheader: "Your account will be deleted if you don't sign in.",
        heading: "Sign in to keep your account",
        paragraphs: [
          greeting(d.name),
          `You haven't signed in since ${formatEt(d.lastLoginAt)}. If you don't sign in before ${formatEt(d.deleteAfter)}, your account will be deleted.`,
        ],
        action: { label: "Sign in", url: d.signInUrl },
      }),
  }),
} as const;

export type TemplateName = keyof typeof TEMPLATES;

export type TemplateData<N extends TemplateName> = z.input<
  (typeof TEMPLATES)[N]["schema"]
>;

export type EmailMessage = {
  [N in TemplateName]: { to: string; template: N; data: TemplateData<N> };
}[TemplateName];

export const TEMPLATE_NAMES = Object.keys(TEMPLATES) as TemplateName[];

export function isTemplateName(value: string): value is TemplateName {
  return Object.hasOwn(TEMPLATES, value);
}

interface AnyTemplate {
  schema: z.ZodType;
  links: readonly string[];
  render: (data: never) => EmailContent;
}

const REGISTRY: Record<TemplateName, AnyTemplate> = TEMPLATES;

export type PreparedEmail =
  | { ok: true; content: EmailContent; linkUrls: string[] }
  | { ok: false; paths: string[] };

/**
 * Validates `data` against the template's schema, renders it, and lists the
 * URLs held in its `links` fields. Failures name issue paths only, never
 * values.
 */
export function prepareTemplate(
  template: TemplateName,
  data: unknown,
): PreparedEmail {
  const entry = REGISTRY[template];
  const parsed = entry.schema.safeParse(data);
  if (!parsed.success) {
    return {
      ok: false,
      paths: parsed.error.issues.map((issue) => issue.path.join(".") || "data"),
    };
  }
  // `render` only ever receives data its own schema produced.
  const content = entry.render(parsed.data as never);
  const fields: Record<string, unknown> =
    typeof parsed.data === "object" && parsed.data !== null
      ? { ...parsed.data }
      : {};
  const linkUrls = entry.links.flatMap((field) => {
    const value = fields[field];
    return typeof value === "string" ? [value] : [];
  });
  return { ok: true, content, linkUrls };
}

/** `prepareTemplate` for callers that want an exception, such as previews. */
export function renderTemplate<N extends TemplateName>(
  template: N,
  data: TemplateData<N>,
): EmailContent {
  const prepared = prepareTemplate(template, data);
  if (!prepared.ok) {
    throw new Error(
      `Invalid data for email template ${template}: ${prepared.paths.join(", ")}`,
    );
  }
  return prepared.content;
}
