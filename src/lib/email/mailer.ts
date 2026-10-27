import "server-only";
import { createHash } from "node:crypto";
import { z } from "zod";
import { normalizeEmail } from "@/lib/auth/policy";
import type { CapName, EmailCaps } from "@/lib/email/caps";
import {
  prepareTemplate,
  type EmailMessage,
  type TemplateName,
} from "@/lib/email/templates";
import { EmailTransportError, type Transport } from "@/lib/email/transports";
import { resolveLinkTarget } from "@/lib/token-links/actions";

export type { EmailMessage };

/**
 * `capped` and `failed` are never thrown and never shown to the user, so a
 * caller keeps its uniform response (ENGINEERING §3, enumeration resistance).
 * A caller that must react, such as an admin invite, reads `status`.
 */
export type SendResult =
  | { status: "sent" }
  | { status: "capped"; cap: CapName }
  | { status: "failed" };

export interface Mailer {
  sendEmail(message: EmailMessage): Promise<SendResult>;
}

export interface MailerLog {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

interface MailerOptions {
  transport: Transport;
  caps: EmailCaps;
  /** The full From header, for example `SGAuth <no-reply@…>`. */
  from: string;
  /** Every link in a message must sit on this origin. */
  linkOrigin: string;
  log: MailerLog;
}

export function hashRecipient(normalizedAddress: string): string {
  return createHash("sha256").update(normalizedAddress).digest("hex");
}

function originOf(link: string): string | null {
  try {
    return new URL(link).origin;
  } catch {
    return null;
  }
}

export function createMailer({
  transport,
  caps,
  from,
  linkOrigin,
  log,
}: MailerOptions): Mailer {
  // Bad input is a caller bug, so it throws (and tests catch it). Runtime
  // conditions return a result instead.
  async function sendEmail(message: EmailMessage): Promise<SendResult> {
    const template: TemplateName = message.template;
    const to = normalizeEmail(message.to);
    if (!z.email().safeParse(to).success) {
      throw new Error(`Invalid recipient for email template ${template}`);
    }

    const prepared = prepareTemplate(template, message.data);
    if (!prepared.ok) {
      throw new Error(
        `Invalid data for email template ${template}: ${prepared.paths.join(", ")}`,
      );
    }

    // Stops a caller mailing an off-site link under SGAuth's name.
    for (const { url } of prepared.links) {
      if (originOf(url) !== linkOrigin) {
        throw new Error(
          `Link for email template ${template} is not on ${linkOrigin}`,
        );
      }
    }

    // Every link must point at its field's registered, live page. The error
    // omits the URL, which holds the token.
    for (const { field, url } of prepared.links) {
      const target = resolveLinkTarget(template, field, url);
      if (!target.ok) {
        throw new Error(
          `Email template ${template} link ${field} is not a registered token-link page (${target.reason})`,
        );
      }
    }

    // After validation and rendering, so a bad call never spends a quota.
    const recipientHash = hashRecipient(to);
    const decision = await caps.check(recipientHash);
    if (!decision.allowed) {
      log.warn("email_capped", { template, recipientHash, cap: decision.cap });
      return { status: "capped", cap: decision.cap };
    }

    try {
      const { id } = await transport.send({
        from,
        to,
        subject: prepared.content.subject,
        html: prepared.content.html,
        text: prepared.content.text,
        template,
      });
      log.info("email_sent", {
        template,
        recipientHash,
        transport: transport.name,
        providerId: id,
      });
      return { status: "sent" };
    } catch (error) {
      log.error("email_failed", {
        template,
        recipientHash,
        transport: transport.name,
        errorName: error instanceof Error ? error.name : "UnknownError",
        ...(error instanceof EmailTransportError
          ? { status: error.status }
          : {}),
      });
      return { status: "failed" };
    }
  }

  return { sendEmail };
}
