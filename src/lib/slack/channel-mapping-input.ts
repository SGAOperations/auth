import { z } from "zod";
import { positionKeySchema } from "../position-key";
import { slackChannelIdSchema, slackTeamIdSchema } from "./ids";

// Pure and client-safe: no database, no `server-only`.

/** A product role (`<slug>-<role>`) and the Slack channel its holders join. */
export const channelMappingInputSchema = z.strictObject({
  roleKey: positionKeySchema,
  slackTeamId: slackTeamIdSchema,
  slackChannelId: slackChannelIdSchema,
});

export type ChannelMappingInput = z.infer<typeof channelMappingInputSchema>;

/**
 * The product slug a role key is prefixed with, or null when none is. The
 * longest slug wins, so `senate-path-admin` is a `senate-path` role and not a
 * `senate` one. A role needs at least one character after `<slug>-`.
 */
export function productSlugForRoleKey(
  roleKey: string,
  slugs: readonly string[],
): string | null {
  let best: string | null = null;
  for (const slug of slugs) {
    if (
      roleKey.length > slug.length + 1 &&
      roleKey.startsWith(`${slug}-`) &&
      (best === null || slug.length > best.length)
    ) {
      best = slug;
    }
  }
  return best;
}
