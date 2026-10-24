import "dotenv/config";
import { mkdir, writeFile } from "node:fs/promises";
import { SAMPLES } from "../src/lib/email/samples";
import {
  isTemplateName,
  prepareTemplate,
  type EmailContent,
} from "../src/lib/email/templates";

// Standalone ops script: renders every sample into .temp/email-preview/ and,
// with --send, mails one sample through Resend for the deliverability check.
// It reads its own env and uses its own fetch, the same exception as
// positions-sync.ts. See docs/EMAIL.md.

const OUT_DIR = ".temp/email-preview";
const DEFAULT_SEND_TEMPLATE = "security-notice";
const DEFAULT_SEND_SAMPLE = "security-notice-password-changed";
const USAGE =
  "Usage: npm run email:preview [-- --send <address> [--template <name>]]";

function render(): Map<string, EmailContent> {
  const rendered = new Map<string, EmailContent>();
  for (const sample of SAMPLES) {
    const prepared = prepareTemplate(sample.template, sample.data);
    if (!prepared.ok) {
      throw new Error(
        `Sample ${sample.id} is invalid: ${prepared.paths.join(", ")}`,
      );
    }
    rendered.set(sample.id, prepared.content);
  }
  return rendered;
}

async function writePreviews(rendered: Map<string, EmailContent>) {
  await mkdir(OUT_DIR, { recursive: true });
  for (const [id, content] of rendered) {
    await writeFile(`${OUT_DIR}/${id}.html`, content.html);
    await writeFile(`${OUT_DIR}/${id}.txt`, content.text);
    console.log(`${OUT_DIR}/${id}.html`);
    console.log(`${OUT_DIR}/${id}.txt`);
  }
}

function option(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  if (index === -1) return undefined;
  const value = args[index + 1];
  if (!value || value.startsWith("--")) throw new Error(USAGE);
  return value;
}

async function send(
  args: string[],
  rendered: Map<string, EmailContent>,
): Promise<void> {
  const to = option(args, "--send");
  if (!to) return;

  const template = option(args, "--template") ?? DEFAULT_SEND_TEMPLATE;
  if (!isTemplateName(template))
    throw new Error(`Unknown template: ${template}`);
  const sampleId =
    template === DEFAULT_SEND_TEMPLATE
      ? DEFAULT_SEND_SAMPLE
      : SAMPLES.find((sample) => sample.template === template)?.id;
  const content = sampleId ? rendered.get(sampleId) : undefined;
  if (!content) throw new Error(`No sample for template: ${template}`);

  const apiKey = process.env.RESEND_API_KEY;
  const from = process.env.RESEND_FROM_EMAIL;
  if (!apiKey || !from) {
    throw new Error(
      "--send needs RESEND_API_KEY and RESEND_FROM_EMAIL in .env",
    );
  }

  const response = await fetch("https://api.resend.com/emails", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      from: `SGAuth <${from}>`,
      to: [to],
      subject: content.subject,
      html: content.html,
      text: content.text,
      tags: [{ name: "template", value: template }],
    }),
    signal: AbortSignal.timeout(10_000),
  });
  // Prints the id or the status only: a response body can echo the address.
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const body: unknown = await response.json().catch(() => null);
  const id =
    typeof body === "object" &&
    body !== null &&
    "id" in body &&
    typeof body.id === "string"
      ? body.id
      : "unknown";
  console.log(`Sent ${template}: Resend id ${id}`);
}

async function main() {
  const args = process.argv.slice(2);
  const rendered = render();
  await writePreviews(rendered);
  await send(args, rendered);
}

main().catch((error: unknown) => {
  console.error(
    error instanceof Error ? error.message : "email:preview failed",
  );
  process.exit(1);
});
