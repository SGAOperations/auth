/** The `sendEmail({ to, template, data })` shape planned in AUTH-T20. */
export type EmailMessage = {
  to: string;
  template: string;
  data: Record<string, unknown>;
};

export type CapturingMailer = {
  sendEmail(message: EmailMessage): Promise<void>;
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
