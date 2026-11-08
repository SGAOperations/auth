import {
  ACK_TEXT,
  FAILURE_TEXT,
  WRONG_TEAM_TEXT,
} from "@/lib/access-requests/replies";
import {
  ephemeral,
  isSlackResponseUrl,
  parseSlackCommandBody,
  type SlackReply,
} from "@/lib/slack/command";
import { verifySlackRequest } from "@/lib/slack/signature";

// Pure like jobs/handler.ts: no env, no Prisma, no `server-only`, so the
// signature check, the status matrix and the three-second race are
// unit-testable. `command-routes.ts` wires it.

/** Slack drops a command that is not answered in 3 s; this leaves cold-start room. */
export const SLACK_REPLY_DEADLINE_MS = 2000;

export interface SlackCommandInput {
  slackTeamId: string;
  slackUserId: string;
  text: string;
}

/** What `run` returns: the reply text, and a short status for the log only. */
export interface SlackCommandResult {
  status: string;
  text: string;
}

export interface SlackCommandLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

interface SlackCommandHandlerOptions {
  /** Log prefix, such as `slack_command.access`. */
  name: string;
  /** The slash command this route serves, such as `/access`. */
  command: string;
  signingSecret: string | undefined;
  /** The one workspace allowed, when configured. */
  teamId: string | undefined;
  run: (input: SlackCommandInput) => Promise<SlackCommandResult>;
  deadlineMs?: number;
  /** POSTs the final reply to Slack's `response_url`. */
  postFollowUp: (responseUrl: string, reply: SlackReply) => Promise<void>;
  /** Keeps the function alive until the task settles (`after()`). */
  defer: (task: Promise<unknown>) => void;
  log: SlackCommandLogger;
}

const DEADLINE = Symbol("deadline");

function json(body: unknown, status: number): Response {
  return Response.json(body, {
    status,
    headers: { "Cache-Control": "no-store" },
  });
}

const errorName = (err: unknown) =>
  err instanceof Error ? err.name : "unknown";

/**
 * Wraps a slash-command service in Slack's request signature, the form parse
 * and the three-second window. Every authentication failure answers the same
 * 401. Logs never carry the body, the text, the `response_url` or Slack ids.
 */
export function createSlackCommandHandler({
  name,
  command,
  signingSecret,
  teamId,
  run,
  deadlineMs = SLACK_REPLY_DEADLINE_MS,
  postFollowUp,
  defer,
  log,
}: SlackCommandHandlerOptions): (req: Request) => Promise<Response> {
  return async (req) => {
    const verified = await verifySlackRequest(req, signingSecret);
    if (!verified.ok) {
      if (verified.reason === "not_configured")
        log.warn(`${name}.secret_unset`);
      else log.warn(`${name}.unauthorized`, { reason: verified.reason });
      return json({ error: "unauthorized" }, 401);
    }

    const parsed = parseSlackCommandBody(verified.body);
    if (
      !parsed.success ||
      parsed.data.command !== command ||
      !isSlackResponseUrl(parsed.data.response_url)
    ) {
      return json({ error: "bad_request" }, 400);
    }
    const body = parsed.data;

    if (teamId !== undefined && body.team_id !== teamId) {
      log.info(`${name}.replied`, { status: "wrong_team", path: "inline" });
      return json(ephemeral(WRONG_TEAM_TEXT), 200);
    }

    const work = run({
      slackTeamId: body.team_id,
      slackUserId: body.user_id,
      text: body.text,
    }).catch((err: unknown): SlackCommandResult => {
      log.error(`${name}.failed`, { errorName: errorName(err) });
      return { status: "error", text: FAILURE_TEXT };
    });

    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof DEADLINE>((resolve) => {
      timer = setTimeout(() => resolve(DEADLINE), deadlineMs);
    });
    const winner = await Promise.race([work, deadline]);
    clearTimeout(timer);

    if (winner !== DEADLINE) {
      log.info(`${name}.replied`, { status: winner.status, path: "inline" });
      return json(ephemeral(winner.text), 200);
    }

    defer(
      work
        .then(async ({ status, text }) => {
          await postFollowUp(body.response_url, {
            ...ephemeral(text),
            replace_original: true,
          });
          log.info(`${name}.replied`, { status, path: "deferred" });
        })
        .catch((err: unknown) => {
          log.error(`${name}.follow_up_failed`, { errorName: errorName(err) });
        }),
    );
    return json(ephemeral(ACK_TEXT), 200);
  };
}
