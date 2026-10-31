// Pure: no env, no `server-only`. The outcome a Slack linking step sends the
// user back to the account page with, and what the page says about it.

export const SLACK_RESULTS = {
  linked: "Your Slack account is linked.",
  unlinked: "Your Slack account is no longer linked.",
  unchanged: "Nothing changed.",
  taken:
    "That Slack account is linked to a different SGA account. Unlink it there first, or ask an admin.",
  invalid_token:
    "That link has expired or was already used. Run the Slack command again for a new one.",
  wrong_team: "Only the SGA Slack workspace can be linked.",
  not_configured: "Connecting Slack from here is not set up yet.",
  failed: "Slack sign-in did not complete. Try again.",
  rate_limited: "Too many attempts. Wait a few minutes and try again.",
} as const;

export type SlackResult = keyof typeof SLACK_RESULTS;

/** Where a finished step lands: the account page's Slack card. */
export function slackResultPath(result: SlackResult): string {
  return `/account?slack=${result}#slack`;
}

/** The message for a `?slack=` value, or null for none or an unknown one. */
export function slackResultMessage(
  value: string | string[] | undefined,
): { result: SlackResult; message: string } | null {
  if (typeof value !== "string" || !Object.hasOwn(SLACK_RESULTS, value)) {
    return null;
  }
  const result = value as SlackResult;
  return { result, message: SLACK_RESULTS[result] };
}
