import { z } from "zod";
import { slackTeamIdSchema, slackUserIdSchema } from "@/lib/slack/ids";

// Pure and client-safe: no database, no env, no `server-only`. The pieces of a
// Slack slash command that the handler and the reply builders share (#342).

/**
 * The form body Slack POSTs for a slash command. Loose, because Slack adds
 * fields (`channel_id`, `trigger_id`, ...) and this route reads none of them.
 */
export const slackCommandBodySchema = z.looseObject({
  command: z.string(),
  team_id: slackTeamIdSchema,
  user_id: slackUserIdSchema,
  text: z.string().max(4000).default(""),
  response_url: z.url(),
});

export type SlackCommandBody = z.infer<typeof slackCommandBodySchema>;

/** Parses the raw `application/x-www-form-urlencoded` body Slack signed. */
export function parseSlackCommandBody(raw: string) {
  return slackCommandBodySchema.safeParse(
    Object.fromEntries(new URLSearchParams(raw)),
  );
}

/**
 * True only for an `https://hooks.slack.com/...` URL. The `response_url` is a
 * value from the request, so this guards the outbound POST against SSRF.
 */
export function isSlackResponseUrl(url: string): boolean {
  try {
    const parsed = new URL(url);
    return (
      parsed.protocol === "https:" &&
      parsed.hostname === "hooks.slack.com" &&
      parsed.username === "" &&
      parsed.password === ""
    );
  } catch {
    return false;
  }
}

const SLACK_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
};

/** Undoes Slack's escaping of `&`, `<` and `>` in command text, in one pass. */
export function decodeSlackText(text: string): string {
  return text.replace(/&(?:amp|lt|gt);/g, (entity) => SLACK_ENTITIES[entity]);
}

/** Escapes `&`, `<` and `>`, the only characters Slack asks a sender to escape. */
export function escapeSlackText(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

export interface SlackReply {
  response_type: "ephemeral";
  text: string;
  replace_original?: boolean;
}

/** A reply only the person who ran the command sees. */
export function ephemeral(text: string): SlackReply {
  return { response_type: "ephemeral", text };
}

/** `text` in a code block, escaped. The caller guarantees it holds no backtick. */
export function codeBlock(text: string): string {
  return `\`\`\`${escapeSlackText(text)}\`\`\``;
}
