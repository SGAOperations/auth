import type { AccessInputError } from "@/lib/access-requests/input";
import { ACCESS_REQUEST_LIMITS } from "@/lib/access-requests/limits";
import { REASON_COPY } from "@/lib/admin/denial-copy";
import { codeBlock, escapeSlackText } from "@/lib/slack/command";

// Pure: the words of every `/access` reply (#342). The outcome type lives here
// so `submit.ts` (server-only) and this module need no import cycle.

export type AccessSubmitOutcome =
  | { status: "submitted"; requestId: string; copy: string }
  | { status: "not_linked" }
  | { status: "inactive" }
  | { status: "not_submitter" }
  | { status: "invalid"; error: AccessInputError };

export const WRONG_TEAM_TEXT =
  "This command works only in the SGA Slack workspace.";
export const ACK_TEXT = "Submitting your access request…";
export const FAILURE_TEXT =
  "Something went wrong and your request was not recorded. Try again in a minute.";

// Slack asks senders to escape `<`, `>` and `&`, so the placeholders are
// written as entities.
const USAGE = [
  `Usage: \`/access ${escapeSlackText("<product> | <access you need>")}\``,
  "Example: `/access Notion | Edit access to the Finance workspace`",
].join("\n");

const INVALID_TEXT: Record<AccessInputError, string> = {
  usage: USAGE,
  missing_part: `Both parts are needed: the product before the |, and the access you need after it.\n${USAGE}`,
  product_too_long: `The product name can be at most ${ACCESS_REQUEST_LIMITS.product} characters.`,
  access_too_long: `The access description can be at most ${ACCESS_REQUEST_LIMITS.access} characters.`,
  bad_characters:
    "Remove backticks (`) and special characters, then try again.",
};

/** The reply text for an outcome. `accountUrl` is SGAuth's account page. */
export function accessReplyText(
  outcome: AccessSubmitOutcome,
  { accountUrl }: { accountUrl: string },
): string {
  switch (outcome.status) {
    case "submitted":
      return `Your access request is recorded. Nothing is granted automatically. Copy this to share it:\n${codeBlock(outcome.copy)}`;
    case "not_linked":
      return `Your Slack account isn't linked to SGAuth. Link it under *Connect Slack* on <${accountUrl}|your SGAuth account>, then try again.`;
    case "inactive":
      return "Your SGAuth account isn't active, so you can't submit access requests.";
    case "not_submitter":
      return `${REASON_COPY.NOT_ACCESS_SUBMITTER} If you think it should, ask an SGAuth admin.`;
    case "invalid":
      return INVALID_TEXT[outcome.error];
  }
}
