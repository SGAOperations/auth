import { z } from "zod";

// Pure and client-safe: no database, no `server-only`.
//
// Slack ids are upper-case letters and digits behind a one-letter type prefix.
// Nothing is trimmed or case-folded: a padded or lower-case id is rejected.

/** A Slack workspace id. Enterprise Grid org ids (E…) are not workspaces. */
export const slackTeamIdSchema = z.string().regex(/^T[A-Z0-9]{2,20}$/);
/** A Slack user id: U… for members, W… for Enterprise Grid members. */
export const slackUserIdSchema = z.string().regex(/^[UW][A-Z0-9]{2,20}$/);
/**
 * A Slack channel id: C… for channels. G… is the legacy private-channel prefix
 * that older private channels still carry. D… is a DM, not a channel.
 */
export const slackChannelIdSchema = z.string().regex(/^[CG][A-Z0-9]{2,20}$/);
