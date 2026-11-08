import { z } from "zod";
import { slackTeamIdSchema, slackUserIdSchema } from "./ids";
import { verifySlackRequest } from "./signature";

// Pure on purpose, like signature.ts and jobs/handler.ts: no `server-only`, no
// env and no Prisma, so it is unit-testable without mocks. SGAssist's `/who-is`
// (#349): parse Slack's form body, ask `lookup` who the mentioned person is,
// and render an ephemeral reply. The caller wires in the secret, the lookup and
// the logger (who-is-route.ts).

export interface WhoIsPosition {
  name: string;
  category: string | null;
  isLeadership: boolean;
  manager: { name: string; category: string | null } | null;
}

export type WhoIsResult =
  | { kind: "caller_unlinked" }
  | { kind: "target_unlinked" }
  | { kind: "found"; name: string; positions: WhoIsPosition[] };

export interface WhoIsLookupInput {
  slackTeamId: string;
  callerSlackUserId: string;
  targetSlackUserId: string;
}

export interface WhoIsHandlerDeps {
  signingSecret: string | undefined;
  teamId: string | undefined;
  accountUrl: string;
  lookup: (input: WhoIsLookupInput) => Promise<WhoIsResult>;
  log: {
    warn(msg: string, fields?: Record<string, unknown>): void;
    error(msg: string, fields?: Record<string, unknown>): void;
  };
  now?: () => Date;
}

/**
 * Not strict: Slack sends many other fields. `command` is deliberately not
 * checked, because each command has its own Request URL and a dev app may name
 * the command differently.
 */
export const whoIsPayloadSchema = z.object({
  team_id: slackTeamIdSchema,
  user_id: slackUserIdSchema,
  text: z.string().max(4000).default(""),
});

export type WhoIsPayload = z.infer<typeof whoIsPayloadSchema>;

export function parseWhoIsPayload(body: string): WhoIsPayload | null {
  const parsed = whoIsPayloadSchema.safeParse(
    Object.fromEntries(new URLSearchParams(body)),
  );
  return parsed.success ? parsed.data : null;
}

/**
 * The Slack user id of the one `<@U…>` mention that is all of `text`, or null.
 * Two mentions, extra words and plain `@name` text (escaping off in the Slack
 * app) all return null.
 */
export function parseMention(text: string): string | null {
  const match = /^\s*<@([UW][A-Z0-9]{2,20})(?:\|[^>]*)?>\s*$/.exec(text);
  if (!match) return null;
  const parsed = slackUserIdSchema.safeParse(match[1]);
  return parsed.success ? parsed.data : null;
}

/** Slack's mrkdwn escapes: `&` first, so the other two are not escaped twice. */
export function escapeSlackText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** By category (uncategorized last), then by name. */
export function sortWhoIsPositions(
  positions: readonly WhoIsPosition[],
): WhoIsPosition[] {
  return [...positions].sort((a, b) => {
    if (a.category !== b.category) {
      if (a.category === null) return 1;
      if (b.category === null) return -1;
      const byCategory = a.category.localeCompare(b.category);
      if (byCategory !== 0) return byCategory;
    }
    return a.name.localeCompare(b.name);
  });
}

function describePosition(p: { name: string; category: string | null }) {
  const name = escapeSlackText(p.name);
  return p.category === null
    ? name
    : `${name} (${escapeSlackText(p.category)})`;
}

function positionLine(p: WhoIsPosition): string {
  const segments = [`*${escapeSlackText(p.name)}*`];
  if (p.category !== null) segments.push(escapeSlackText(p.category));
  segments.push(
    p.isLeadership ? "Leadership position" : "Not a leadership position",
  );
  const reportsTo = p.manager
    ? describePosition(p.manager)
    : "no manager position set";
  return `• ${segments.join(" · ")}\n    Reports to: ${reportsTo}`;
}

function accountLink(accountUrl: string, label: string): string {
  return `<${accountUrl}|${label}>`;
}

export const usageReply = () =>
  "Usage: `/who-is @person`. Mention exactly one person.";
export const wrongTeamReply = () =>
  "/who-is only works in the SGA Slack workspace.";
export const unreadableReply = () =>
  "Sorry, that command couldn't be read. Try again.";
export const failureReply = () =>
  "Something went wrong looking that up. Try again in a minute.";

export function renderWhoIsReply(
  result: WhoIsResult,
  {
    targetSlackUserId,
    accountUrl,
  }: { targetSlackUserId: string; accountUrl: string },
): string {
  if (result.kind === "caller_unlinked") {
    return `Link your Slack account to SGAuth to use /who-is. You can link it at ${accountLink(accountUrl, "your SGAuth account page")}.`;
  }
  const mention = `<@${targetSlackUserId}>`;
  if (result.kind === "target_unlinked") {
    return `${mention} hasn't linked their Slack account to SGAuth, so there's nothing to show yet. They can link it at ${accountLink(accountUrl, "their SGAuth account page")}.`;
  }
  const who = `*${escapeSlackText(result.name)}* (${mention})`;
  if (result.positions.length === 0) {
    return `${who} doesn't hold any positions in SGAuth.`;
  }
  const count = result.positions.length;
  const header = `${who} holds ${count} ${count === 1 ? "position" : "positions"}:`;
  return [header, ...result.positions.map(positionLine)].join("\n");
}

function ephemeral(text: string): Response {
  return Response.json(
    { response_type: "ephemeral", text },
    { status: 200, headers: { "Cache-Control": "no-store" } },
  );
}

/**
 * The `/who-is` handler. Read only: it writes no rows and no audit event.
 * An unverified request gets the same generic 401 for every reason; every
 * other outcome is an ephemeral 200, so Slack shows the message instead of
 * `http_service_error`.
 */
export function createWhoIsHandler(
  deps: WhoIsHandlerDeps,
): (req: Request) => Promise<Response> {
  const now = deps.now ?? (() => new Date());
  return async (req) => {
    const verified = await verifySlackRequest(req, deps.signingSecret, now());
    if (!verified.ok) {
      deps.log.warn("slack_command.unverified", {
        command: "who-is",
        reason: verified.reason,
      });
      return Response.json({ error: "unauthorized" }, { status: 401 });
    }

    // Slack's certificate probe: answered only once the signature has checked out.
    if (new URLSearchParams(verified.body).get("ssl_check") === "1") {
      return new Response(null, { status: 200 });
    }

    const payload = parseWhoIsPayload(verified.body);
    if (!payload) return ephemeral(unreadableReply());
    if (deps.teamId !== undefined && payload.team_id !== deps.teamId) {
      return ephemeral(wrongTeamReply());
    }
    const targetSlackUserId = parseMention(payload.text);
    if (!targetSlackUserId) return ephemeral(usageReply());

    let result: WhoIsResult;
    try {
      result = await deps.lookup({
        slackTeamId: payload.team_id,
        callerSlackUserId: payload.user_id,
        targetSlackUserId,
      });
    } catch (err) {
      deps.log.error("slack_command.failed", { command: "who-is", err });
      return ephemeral(failureReply());
    }
    return ephemeral(
      renderWhoIsReply(result, {
        targetSlackUserId,
        accountUrl: deps.accountUrl,
      }),
    );
  };
}
