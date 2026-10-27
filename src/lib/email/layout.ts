// Pure on purpose: no `server-only`, no `@/` imports and no env, so templates
// render in Next, in Vitest and in scripts/email-preview.ts under plain Node.

const FOOTER = "Replies to this address aren't read.";

const HTML_ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

export function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => HTML_ESCAPES[char]);
}

const ET_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/New_York",
  dateStyle: "long",
  timeStyle: "short",
});

/** `October 16, 2026 at 3:00 PM ET` */
export function formatEt(date: Date): string {
  return `${ET_FORMAT.format(date)} ET`;
}

function plural(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/**
 * Whole days when the value divides into two or more days, else hours, else
 * minutes: one day reads as "24 hours".
 */
export function formatDuration(minutes: number): string {
  if (minutes >= 2880 && minutes % 1440 === 0) {
    return plural(minutes / 1440, "day");
  }
  if (minutes % 60 === 0) return plural(minutes / 60, "hour");
  return plural(minutes, "minute");
}

export interface LayoutInput {
  preheader: string;
  heading: string;
  paragraphs: readonly string[];
  action?: { label: string; url: string };
  /** Shown after the paragraphs and the button, before the footer. */
  afterAction?: readonly string[];
}

export interface RenderedBody {
  html: string;
  text: string;
}

// Inline styles and tables only: mail clients ignore external CSS.
const FONT = "font-family:Arial,Helvetica,sans-serif;";

export function renderLayout(input: LayoutInput): RenderedBody {
  const { preheader, heading, paragraphs, action, afterAction = [] } = input;

  const paragraphHtml = (text: string) =>
    `<p style="${FONT}font-size:16px;line-height:24px;color:#1f2933;margin:0 0 16px;">${escapeHtml(text)}</p>`;

  const actionHtml = action
    ? `<p style="margin:8px 0 24px;"><a href="${escapeHtml(action.url)}" style="${FONT}display:inline-block;background:#c8102e;color:#ffffff;font-size:16px;font-weight:bold;text-decoration:none;padding:12px 24px;border-radius:6px;">${escapeHtml(action.label)}</a></p>` +
      `<p style="${FONT}font-size:14px;line-height:20px;color:#52606d;margin:0 0 16px;">If the button doesn't work, copy this link:<br><a href="${escapeHtml(action.url)}" style="color:#52606d;word-break:break-all;">${escapeHtml(action.url)}</a></p>`
    : "";

  const html = [
    "<!doctype html>",
    '<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">',
    `<title>${escapeHtml(heading)}</title></head>`,
    '<body style="margin:0;padding:0;background:#f5f7fa;">',
    `<div style="display:none;max-height:0;overflow:hidden;">${escapeHtml(preheader)}</div>`,
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#f5f7fa;"><tr><td align="center" style="padding:24px 12px;">',
    '<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:600px;background:#ffffff;border-radius:8px;">',
    `<tr><td style="${FONT}font-size:14px;font-weight:bold;letter-spacing:1px;color:#c8102e;padding:24px 32px 0;">SGAuth</td></tr>`,
    `<tr><td style="padding:16px 32px 8px;"><h1 style="${FONT}font-size:22px;line-height:28px;color:#102a43;margin:0 0 16px;">${escapeHtml(heading)}</h1>`,
    paragraphs.map(paragraphHtml).join(""),
    actionHtml,
    afterAction.map(paragraphHtml).join(""),
    "</td></tr>",
    `<tr><td style="${FONT}font-size:12px;line-height:18px;color:#7b8794;padding:16px 32px 24px;border-top:1px solid #e4e7eb;">${escapeHtml(FOOTER)}</td></tr>`,
    "</table></td></tr></table></body></html>",
  ].join("\n");

  const textLines = [
    "SGAuth",
    "",
    heading,
    "",
    ...paragraphs.flatMap((p) => [p, ""]),
    ...(action ? [`${action.label}:`, action.url, ""] : []),
    ...afterAction.flatMap((p) => [p, ""]),
    "--",
    FOOTER,
  ];

  return { html, text: textLines.join("\n") };
}
