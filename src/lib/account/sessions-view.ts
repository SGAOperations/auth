import { z } from "zod";

// Pure and client-safe: no database, no `server-only`. The browser's view of
// GET /api/sgauth/sessions and DELETE /api/sgauth/sessions/:id.

/** A mirror of the 200 body of the list route. Extra element fields are tolerated. */
export const sessionListSchema = z.object({
  sessions: z.array(
    z.looseObject({
      id: z.string(),
      createdAt: z.string(),
      lastActiveAt: z.string(),
      ip: z.string().nullable(),
      device: z.string(),
      isCurrent: z.boolean(),
    }),
  ),
});

export type SessionListItem = z.infer<
  typeof sessionListSchema
>["sessions"][number];

/**
 * The meta line under a device name, for example
 * `Active Oct 19, 2026 · Signed in Oct 2, 2026 · 203.0.113.7`. The last-active
 * time is accurate to about a day, so only the date is shown.
 */
export function formatSessionMeta(
  view: Pick<SessionListItem, "createdAt" | "lastActiveAt" | "ip">,
  { timeZone }: { timeZone?: string } = {},
): string {
  const format = new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeZone,
  });
  const parts = [
    `Active ${format.format(new Date(view.lastActiveAt))}`,
    `Signed in ${format.format(new Date(view.createdAt))}`,
  ];
  if (view.ip) parts.push(view.ip);
  return parts.join(" · ");
}

export type RevokeOutcome =
  | "revoked"
  | "gone"
  | "signed-out"
  | "reauth"
  | "failed";

/**
 * What a DELETE /api/sgauth/sessions/:id answer means for the page. `error` is
 * the `error` field of a JSON body, read only for a 403: the route answers 403
 * both for a bad origin and for a session that must re-authenticate first.
 */
export function revokeOutcome(status: number, error?: unknown): RevokeOutcome {
  switch (status) {
    case 204:
      return "revoked";
    case 404:
      return "gone";
    case 401:
      return "signed-out";
    case 403:
      return error === "REAUTH_REQUIRED" ? "reauth" : "failed";
    default:
      return "failed";
  }
}
