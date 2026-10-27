import type { SendResult } from "@/lib/email/mailer";

/**
 * Deliberately loose: tests may capture any template name or data. The real
 * contract is `EmailMessage` in `@/lib/email/mailer`, and `CapturingMailer`
 * satisfies its `Mailer` interface.
 */
export type EmailMessage = {
  to: string;
  template: string;
  data: Record<string, unknown>;
};

export type CapturingMailer = {
  sendEmail(message: EmailMessage): Promise<SendResult>;
  sent: EmailMessage[];
  to(address: string): EmailMessage[];
  last(): EmailMessage | undefined;
  clear(): void;
};

/** In-memory mailer that records every message instead of sending it. */
export function createCapturingMailer(): CapturingMailer {
  const sent: EmailMessage[] = [];
  return {
    // A clone, so a caller mutating its message later cannot rewrite history.
    sendEmail: async (message) => {
      sent.push(structuredClone(message));
      return { status: "sent" };
    },
    sent,
    // Case-insensitive, matching the citext email column.
    to: (address) =>
      sent.filter((m) => m.to.toLowerCase() === address.toLowerCase()),
    last: () => sent.at(-1),
    clear: () => {
      sent.length = 0;
    },
  };
}
