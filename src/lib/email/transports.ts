import "server-only";

export interface TransportMessage {
  from: string;
  to: string;
  subject: string;
  html: string;
  text: string;
  template: string;
}

export interface Transport {
  name: string;
  send(message: TransportMessage): Promise<{ id?: string }>;
}

/** Carries the HTTP status only: a response body can echo the address. */
export class EmailTransportError extends Error {
  readonly status: number;

  constructor(status: number) {
    super(`Email provider responded with HTTP ${status}`);
    this.name = "EmailTransportError";
    this.status = status;
  }
}

const RESEND_URL = "https://api.resend.com/emails";
const RESEND_TIMEOUT_MS = 10_000;

export function createResendTransport({
  apiKey,
  fetch = globalThis.fetch,
}: {
  apiKey: string;
  fetch?: typeof globalThis.fetch;
}): Transport {
  return {
    name: "resend",
    async send({ from, to, subject, html, text, template }) {
      const response = await fetch(RESEND_URL, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          from,
          to: [to],
          subject,
          html,
          text,
          tags: [{ name: "template", value: template }],
        }),
        signal: AbortSignal.timeout(RESEND_TIMEOUT_MS),
      });
      if (!response.ok) throw new EmailTransportError(response.status);
      const body: unknown = await response.json().catch(() => null);
      const id =
        typeof body === "object" &&
        body !== null &&
        "id" in body &&
        typeof body.id === "string"
          ? body.id
          : undefined;
      return { id };
    },
  };
}

/**
 * Local only, so a developer can click the link. It prints the address and the
 * body on purpose, bypassing the redacting logger.
 */
export function createConsoleTransport({
  write = console.info,
}: {
  write?: (message: string) => void;
} = {}): Transport {
  return {
    name: "console",
    async send({ to, subject, text }) {
      write(
        `\n--- email ---\nTo: ${to}\nSubject: ${subject}\n\n${text}\n---\n`,
      );
      return {};
    },
  };
}

/** Preview without Resend: the send is logged by the mailer and goes nowhere. */
export const discardTransport: Transport = {
  name: "discard",
  async send() {
    return {};
  },
};
