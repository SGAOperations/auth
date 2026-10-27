import { z } from "zod";
import { RULE_KEYS, type RuleKey } from "@/lib/alerts/rules";
import { formatDuration, formatEt, renderLayout } from "./layout";

// Pure on purpose, like layout.ts: no `server-only`, no env. Each template is a
// zod schema plus a render function. Paragraph strings are built here from
// data and escaped once, in the layout.

export interface EmailContent {
  subject: string;
  html: string;
  text: string;
}

// Names reach subject lines, so control characters (CR, LF) are rejected.
const personName = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .regex(/^[^\p{Cc}]+$/u, "must not contain control characters");

const name = personName.optional();

const url = z.url({ protocol: /^https?$/ });

const expiresInMinutes = z.number().int().positive();

function greeting(recipient?: string, salutation = "Hi"): string {
  return recipient ? `${salutation} ${recipient},` : `${salutation},`;
}

// Primary Admin emails open with "Hello".
function adminGreeting(): string {
  return greeting(undefined, "Hello");
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
    subject: "Your SGAuth password was changed",
    heading: "Your password was changed",
    body: (when: string) =>
      `Your password was changed on ${when}. If this wasn't you, reset your password immediately and contact SGA Operational Affairs.`,
  },
  "password-reset": {
    subject: "Your SGAuth password was reset",
    heading: "Your password was reset",
    body: (when: string) =>
      `Your password was reset on ${when}. If this wasn't you, reset your password immediately and contact SGA Operational Affairs.`,
  },
  "admin-granted": {
    subject: "You now have admin access in SGAuth",
    heading: "You now have admin access",
    body: (when: string) =>
      `This happened at ${when}. If this wasn't you, reset your password right away and contact SGA.`,
  },
} as const;

const ALERT_HEADLINES: Record<RuleKey, string> = {
  "login-failed-spike": "SGA Auth: failed sign-in spike",
  "account-locked-spike": "SGA Auth: account lockout spike",
  "break-glass": "SGA Auth: break-glass recovery used",
  "pa-transfer-initiated": "SGA Auth: Primary Admin transfer started",
  "jwks-rotated": "SGA Auth: signing keys rotated",
  "job-failed": "SGA Auth: scheduled job failed",
  "upstash-fail-open": "SGA Auth: Upstash fail-open",
};

function times(count: number): string {
  return count === 1 ? "1 time" : `${count} times`;
}

const alertItem = z.object({
  rule: z.enum(RULE_KEYS),
  count: z.number().int().min(1),
  since: z.date().optional(),
  jobs: z
    .array(z.string().regex(/^[a-z][a-z0-9-]{0,63}$/))
    .max(5)
    .optional(),
});

type AlertItem = z.infer<typeof alertItem>;

function alertBullet(item: AlertItem): string {
  const since = item.since ? ` since ${formatEt(item.since)}` : "";
  const n = item.count;
  switch (item.rule) {
    case "login-failed-spike":
      return `${n} failed sign-ins in the last 15 minutes (alert threshold: 50).`;
    case "account-locked-spike":
      return `${n} accounts locked in the last hour (alert threshold: 5).`;
    case "break-glass":
      return `Break-glass Primary Admin recovery was used ${times(n)}${since}.`;
    case "pa-transfer-initiated":
      return `${n} Primary Admin ${n === 1 ? "transfer" : "transfers"} started${since}.`;
    case "jwks-rotated":
      return `The token signing keys were rotated ${times(n)}${since}.`;
    case "job-failed": {
      const jobs = item.jobs?.length ? `: ${item.jobs.join(", ")}` : "";
      return `${n} scheduled job ${n === 1 ? "run" : "runs"} failed${since}${jobs}.`;
    }
    case "upstash-fail-open":
      return `Upstash was unreachable ${times(n)}${since}, so rate limits or email caps were not enforced.`;
  }
}

export const TEMPLATES = {
  "verify-email": defineTemplate({
    schema: z.object({ name, url, expiresInMinutes }),
    links: ["url"],
    render: (d) =>
      compose("Verify your email for SGAuth", {
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
      compose("Reset your SGAuth password", {
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
        invite ? "You've been invited to SGAuth" : "Set your SGAuth password",
        {
          preheader: "Set a password to finish setting up your account.",
          heading: invite ? "You've been invited" : "Set your password",
          paragraphs: [
            greeting(d.name),
            ...(invite ? ["An SGA admin set up an account for you."] : []),
            "Your account is ready, but it has no password yet.",
            `This link expires in ${formatDuration(d.expiresInMinutes)}.`,
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
        paragraphs: [greeting(d.name), event.body(formatEt(d.occurredAt))],
      });
    },
  }),

  "pa-transfer-initiated": defineTemplate({
    schema: z.discriminatedUnion("role", [
      z.object({
        role: z.literal("recipient"),
        url,
        fromName: personName,
        acceptBy: z.date(),
      }),
      z.object({
        role: z.literal("initiator"),
        toName: personName,
        acceptBy: z.date(),
      }),
    ]),
    links: ["url"],
    render: (d) =>
      d.role === "recipient"
        ? compose(`${d.fromName} wants to make you Primary Admin of SGAuth`, {
            preheader: "Review a Primary Admin transfer.",
            heading: "Primary Admin transfer request",
            paragraphs: [
              adminGreeting(),
              `${d.fromName} wants to make you Primary Admin of SGAuth.`,
              `Accept by ${formatEt(d.acceptBy)}.`,
            ],
            action: { label: "Review transfer", url: d.url },
          })
        : compose(`You started a Primary Admin transfer to ${d.toName}`, {
            preheader: "Your Primary Admin transfer is waiting for a response.",
            heading: "Primary Admin transfer started",
            paragraphs: [
              adminGreeting(),
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
        toName: personName,
        executesAt: z.date(),
      }),
      z.object({
        role: z.literal("recipient"),
        fromName: personName,
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
              adminGreeting(),
              `${d.toName} accepted. The transfer completes at ${formatEt(d.executesAt)}.`,
              "You can cancel until then.",
            ],
            action: { label: "Cancel transfer", url: d.cancelUrl },
          })
        : compose("Primary Admin transfer accepted", {
            preheader: "You are about to become Primary Admin.",
            heading: "Primary Admin transfer accepted",
            paragraphs: [
              adminGreeting(),
              `You'll become Primary Admin at ${formatEt(d.executesAt)}.`,
              `${d.fromName} can cancel the transfer until then.`,
            ],
          }),
  }),

  "pa-transfer-cancelled": defineTemplate({
    schema: z.object({
      role: z.enum(["initiator", "recipient"]),
      otherName: personName,
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
          adminGreeting(),
          REASON_LINES[d.reason](d.otherName),
          "Nothing changed: the current Primary Admin keeps the role.",
        ],
      }),
  }),

  "pa-transfer-completed": defineTemplate({
    schema: z.object({
      role: z.enum(["initiator", "recipient", "admin"]),
      fromName: personName,
      toName: personName,
      completedAt: z.date(),
    }),
    links: [],
    render: (d) =>
      compose(`${d.toName} is now Primary Admin of SGAuth`, {
        preheader: `${d.toName} is now Primary Admin.`,
        heading: "Primary Admin transfer complete",
        paragraphs: [
          adminGreeting(),
          `${d.fromName} transferred the Primary Admin role to ${d.toName} at ${formatEt(d.completedAt)}.`,
          ...(d.role === "admin" ? [] : ["You'll need to sign in again."]),
        ],
      }),
  }),

  "inactivity-notice": defineTemplate({
    schema: z.object({
      name,
      lastLoginAt: z.date(),
      deactivateAfter: z.date(),
      signInUrl: url,
    }),
    links: ["signInUrl"],
    render: (d) =>
      compose("Sign in to keep your SGA account", {
        preheader: "Your account will be deactivated if you don't sign in.",
        heading: "Sign in to keep your account",
        paragraphs: [
          greeting(d.name),
          `You haven't signed in since ${formatEt(d.lastLoginAt)}. If you don't sign in before ${formatEt(d.deactivateAfter)}, your account will be deactivated.`,
        ],
        action: { label: "Sign in", url: d.signInUrl },
      }),
  }),

  "security-alert": defineTemplate({
    schema: z.object({
      name,
      checkedAt: z.date(),
      items: z.array(alertItem).min(1).max(RULE_KEYS.length),
    }),
    links: [],
    render: (d) => {
      const subject =
        d.items.length === 1
          ? ALERT_HEADLINES[d.items[0].rule]
          : `SGA Auth security alert: ${d.items.length} conditions`;
      return compose(subject, {
        preheader: "SGAuth found conditions that need a look.",
        heading: "Security alert",
        paragraphs: [
          greeting(d.name),
          `The alert check at ${formatEt(d.checkedAt)} found:`,
          ...d.items.map((item) => `- ${alertBullet(item)}`),
        ],
        afterAction: [
          "Each condition is reported at most once an hour. If any of this is unexpected, check the audit log and Vercel logs, and see the on-call runbook.",
        ],
      });
    },
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
  | {
      ok: true;
      content: EmailContent;
      links: { field: string; url: string }[];
    }
  | { ok: false; paths: string[] };

/**
 * Validates `data` against the template's schema, renders it, and lists the
 * URLs held in its `links` fields, by field. Failures name issue paths only, never
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
  const links = entry.links.flatMap((field) => {
    const value = fields[field];
    return typeof value === "string" ? [{ field, url: value }] : [];
  });
  return { ok: true, content, links };
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
