import "server-only";
import type { RecoveryMode } from "@/lib/break-glass/cli";

// Notices for scripts/recover-primary-admin.ts. Plain text with no links: the
// message is phishing-sensitive, so it points at the runbook by name only.

export interface RecoveryEmailDetails {
  /** The Primary Admin after the change (transfer) or the one whose MFA was reset. */
  primaryAdminEmail: string;
  /** Transfer only: null when there was no Primary Admin before. */
  previousPrimaryAdminEmail: string | null;
  operator: string;
  reason: string;
  at: Date;
}

export interface RecoveryEmail {
  subject: string;
  text: string;
}

const CONTACT_HINT =
  "If you did not expect this, contact the other credential holders immediately; see the break-glass runbook in the SGAuth repository.";

export function buildRecoveryEmail(
  kind: RecoveryMode,
  details: RecoveryEmailDetails,
): RecoveryEmail {
  const at = details.at.toISOString();
  const who = `Operator: ${details.operator}. Reason: ${details.reason}.`;

  if (kind === "reset_mfa") {
    return {
      subject: "SGAuth: Primary Admin MFA reset by break-glass recovery",
      text: `The authenticator and backup codes of the SGAuth Primary Admin ${details.primaryAdminEmail} were removed at ${at} using the break-glass recovery script. ${who} All sessions of ${details.primaryAdminEmail} were signed out, and they must enrol again before any admin action. ${CONTACT_HINT}`,
    };
  }

  const change = details.previousPrimaryAdminEmail
    ? `changed from ${details.previousPrimaryAdminEmail} to ${details.primaryAdminEmail}`
    : `set to ${details.primaryAdminEmail} (there was no Primary Admin before)`;
  const signedOut = details.previousPrimaryAdminEmail
    ? ` All sessions of ${details.previousPrimaryAdminEmail} were signed out.`
    : "";
  return {
    subject: "SGAuth: Primary Admin changed by break-glass recovery",
    text: `The SGAuth Primary Admin was ${change} at ${at} using the break-glass recovery script, not the normal transfer. ${who}${signedOut} ${CONTACT_HINT}`,
  };
}

export interface RecipientResult {
  to: string;
  status: "ok" | "failed";
}

export type RecoverySender = (
  recipients: string[],
  email: RecoveryEmail,
) => Promise<RecipientResult[]>;

const RESEND_URL = "https://api.resend.com/emails";

/**
 * One message per recipient, so one bad address cannot block the others.
 * Never throws on a send failure and never logs the API key: a failure is just
 * `failed` for that address.
 */
export function createResendSender({
  apiKey,
  from,
  fetch: fetchImpl,
}: {
  apiKey: string;
  from: string;
  fetch: typeof fetch;
}): RecoverySender {
  return async (recipients, email) => {
    const results: RecipientResult[] = [];
    for (const to of recipients) {
      try {
        const response = await fetchImpl(RESEND_URL, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            from,
            to: [to],
            subject: email.subject,
            text: email.text,
          }),
        });
        results.push({ to, status: response.ok ? "ok" : "failed" });
      } catch {
        results.push({ to, status: "failed" });
      }
    }
    return results;
  };
}
