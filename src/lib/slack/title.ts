// Pure: no env, no `server-only`. Builds the leadership title written to a
// person's Slack profile from the positions they hold.

import { sortPositionsForDisplay } from "@/lib/account/tools";

export const SLACK_TITLE_SEPARATOR = " | ";

/**
 * The longest profile `title` that `users.profile.set` accepts, counted in
 * Unicode code points.
 *
 * Supplied by the operator. Not yet checked against Slack's documentation:
 * confirm the documented maximum, the unit (characters or bytes), and cite the
 * source here before relying on it.
 */
export const SLACK_TITLE_MAX_LENGTH = 249;

/**
 * A position a person holds. The caller passes active (not soft-deleted)
 * holdings only; this module never sees `deletedAt`.
 */
export interface TitlePosition {
  key: string;
  name: string;
  isLeadership: boolean;
}

export type LeadershipTitleResult =
  | { ok: true; title: string }
  | { ok: false; reason: string; length: number };

/**
 * The Slack title for a person's leadership positions: their names in display
 * order (name, then key), joined with {@link SLACK_TITLE_SEPARATOR}.
 * Non-leadership positions are ignored. No leadership positions gives an empty
 * title, the value that clears it. A title over {@link SLACK_TITLE_MAX_LENGTH}
 * code points is refused with the reason, not thrown.
 */
export function leadershipTitle(
  positions: readonly TitlePosition[],
): LeadershipTitleResult {
  const title = sortPositionsForDisplay(
    positions.filter((position) => position.isLeadership),
  )
    .map((position) => position.name)
    .join(SLACK_TITLE_SEPARATOR);

  const length = Array.from(title).length;
  if (length > SLACK_TITLE_MAX_LENGTH) {
    return {
      ok: false,
      length,
      reason: `Leadership title is ${length} characters; Slack allows at most ${SLACK_TITLE_MAX_LENGTH}.`,
    };
  }
  return { ok: true, title };
}
