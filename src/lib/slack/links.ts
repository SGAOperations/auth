// Pure: no env, no `server-only`. Where the Slack linking pages live.

/** The account-page section that shows the user's Slack link. */
export const SLACK_ACCOUNT_PATH = "/account/slack";

/** The page a product's DM'd link opens. */
export const SLACK_LINK_PATH = "/account/slack/link";

/** The absolute link a product DMs. The token rides in the query string. */
export function slackLinkUrl(baseURL: string, token: string): string {
  const url = new URL(SLACK_LINK_PATH, baseURL);
  url.searchParams.set("token", token);
  return url.toString();
}
