import { afterEach, describe, expect, it, vi } from "vitest";
import {
  ACK_TEXT,
  FAILURE_TEXT,
  WRONG_TEAM_TEXT,
} from "@/lib/access-requests/replies";
import {
  createSlackCommandHandler,
  SLACK_REPLY_DEADLINE_MS,
  type SlackCommandResult,
} from "@/lib/slack/command-handler";
import { slackSignature } from "@/lib/slack/signature";

const SECRET = "s".repeat(32);
const TEAM = "T0123ABC";
const RESPONSE_URL = "https://hooks.slack.com/commands/T0123ABC/1/secretpath";
const TEXT = "Private Product | Private access words";

const fields = {
  command: "/access",
  team_id: TEAM,
  user_id: "U0456DEF",
  text: TEXT,
  response_url: RESPONSE_URL,
};

function signed(
  overrides: Record<string, string> = {},
  {
    secret = SECRET,
    ageSeconds = 0,
  }: { secret?: string; ageSeconds?: number } = {},
) {
  const body = new URLSearchParams({ ...fields, ...overrides }).toString();
  const timestamp = String(Math.floor(Date.now() / 1000) - ageSeconds);
  return new Request("https://auth.example.test/api/slack/commands/access", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature": slackSignature(secret, timestamp, body),
    },
    body,
  });
}

function setup(
  options: {
    signingSecret?: string | undefined;
    teamId?: string | undefined;
    run?: () => Promise<SlackCommandResult>;
  } = {},
) {
  // `in`, not a default value: an explicit `undefined` means "unset".
  const signingSecret =
    "signingSecret" in options ? options.signingSecret : SECRET;
  const teamId = "teamId" in options ? options.teamId : TEAM;
  const run =
    options.run ??
    (async (): Promise<SlackCommandResult> => ({
      status: "submitted",
      text: "done",
    }));
  const runMock = vi.fn(run);
  const postFollowUp = vi.fn(async () => {});
  const defer = vi.fn<(task: Promise<unknown>) => void>();
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handler = createSlackCommandHandler({
    name: "slack_command.access",
    command: "/access",
    signingSecret,
    teamId,
    run: runMock,
    postFollowUp,
    defer,
    log,
  });
  return { handler, run: runMock, postFollowUp, defer, log };
}

afterEach(() => {
  vi.useRealTimers();
});

describe("createSlackCommandHandler authentication", () => {
  it.each([
    ["a bad signature", () => signed({}, { secret: "x".repeat(32) })],
    ["a stale timestamp", () => signed({}, { ageSeconds: 600 })],
    [
      "missing headers",
      () =>
        new Request("https://auth.example.test/x", {
          method: "POST",
          body: "a=b",
        }),
    ],
  ])("answers the same 401 and never runs for %s", async (_label, make) => {
    const { handler, run } = setup();
    const response = await handler(make());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(run).not.toHaveBeenCalled();
  });

  it("answers the same 401 when the secret is unset", async () => {
    const { handler, run, log } = setup({ signingSecret: undefined });
    const response = await handler(signed());
    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(run).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("slack_command.access.secret_unset");
  });
});

describe("createSlackCommandHandler request checks", () => {
  it.each([
    ["another command", { command: "/other" }],
    ["a non-Slack response_url", { response_url: "https://evil.test/x" }],
    ["a bad user id", { user_id: "nope" }],
  ])("answers 400 for %s", async (_label, change) => {
    const { handler, run } = setup();
    const response = await handler(signed(change));
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({ error: "bad_request" });
    expect(run).not.toHaveBeenCalled();
  });

  it("refuses another workspace without running", async () => {
    const { handler, run } = setup();
    const response = await handler(signed({ team_id: "T0OTHER9" }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: WRONG_TEAM_TEXT,
    });
    expect(run).not.toHaveBeenCalled();
  });

  it("accepts any workspace when none is configured", async () => {
    const { handler, run } = setup({ teamId: undefined });
    const response = await handler(signed({ team_id: "T0OTHER9" }));
    expect(response.status).toBe(200);
    expect(run).toHaveBeenCalledOnce();
  });
});

describe("createSlackCommandHandler replies", () => {
  it("replies inline when the work is fast", async () => {
    const { handler, run, defer, postFollowUp } = setup();
    const response = await handler(signed());

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: "done",
    });
    expect(run).toHaveBeenCalledWith({
      slackTeamId: TEAM,
      slackUserId: "U0456DEF",
      text: TEXT,
    });
    expect(defer).not.toHaveBeenCalled();
    expect(postFollowUp).not.toHaveBeenCalled();
  });

  it("acknowledges and follows up when the work is slow", async () => {
    vi.useFakeTimers();
    let finish: (result: SlackCommandResult) => void = () => {};
    const { handler, defer, postFollowUp, log } = setup({
      run: () =>
        new Promise<SlackCommandResult>((resolve) => {
          finish = resolve;
        }),
    });

    const pending = handler(signed());
    await vi.advanceTimersByTimeAsync(SLACK_REPLY_DEADLINE_MS);
    const response = await pending;

    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: ACK_TEXT,
    });
    expect(defer).toHaveBeenCalledOnce();
    expect(postFollowUp).not.toHaveBeenCalled();

    finish({ status: "submitted", text: "final" });
    await defer.mock.calls[0][0];

    expect(postFollowUp).toHaveBeenCalledWith(RESPONSE_URL, {
      response_type: "ephemeral",
      replace_original: true,
      text: "final",
    });
    expect(log.info).toHaveBeenCalledWith("slack_command.access.replied", {
      status: "submitted",
      path: "deferred",
    });
  });

  it("answers the failure text inline when the work throws", async () => {
    const { handler, log } = setup({
      run: async () => {
        throw new TypeError("secret detail");
      },
    });
    const response = await handler(signed());

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      response_type: "ephemeral",
      text: FAILURE_TEXT,
    });
    expect(log.error).toHaveBeenCalledWith("slack_command.access.failed", {
      errorName: "TypeError",
    });
  });

  it("follows up with the failure text when slow work then throws", async () => {
    vi.useFakeTimers();
    let fail: (err: Error) => void = () => {};
    const { handler, defer, postFollowUp } = setup({
      run: () =>
        new Promise<SlackCommandResult>((_resolve, reject) => {
          fail = reject;
        }),
    });

    const pending = handler(signed());
    await vi.advanceTimersByTimeAsync(SLACK_REPLY_DEADLINE_MS);
    await pending;
    fail(new Error("boom"));
    await defer.mock.calls[0][0];

    expect(postFollowUp).toHaveBeenCalledWith(RESPONSE_URL, {
      response_type: "ephemeral",
      replace_original: true,
      text: FAILURE_TEXT,
    });
  });

  it("logs a failed follow-up without throwing", async () => {
    vi.useFakeTimers();
    let finish: (result: SlackCommandResult) => void = () => {};
    const { handler, defer, postFollowUp, log } = setup({
      run: () =>
        new Promise<SlackCommandResult>((resolve) => {
          finish = resolve;
        }),
    });
    postFollowUp.mockRejectedValueOnce(new RangeError("down"));

    const pending = handler(signed());
    await vi.advanceTimersByTimeAsync(SLACK_REPLY_DEADLINE_MS);
    await pending;
    finish({ status: "submitted", text: "final" });
    await defer.mock.calls[0][0];

    expect(log.error).toHaveBeenCalledWith(
      "slack_command.access.follow_up_failed",
      {
        errorName: "RangeError",
      },
    );
  });

  it("never logs the text, the response_url or Slack ids", async () => {
    const { handler, log } = setup({
      run: async () => {
        throw new Error(`failed on ${TEXT} ${RESPONSE_URL}`);
      },
    });
    await handler(signed());
    await handler(signed({ team_id: "T0OTHER9" }));
    await handler(signed({}, { secret: "x".repeat(32) }));

    const logged = JSON.stringify([
      log.info.mock.calls,
      log.warn.mock.calls,
      log.error.mock.calls,
    ]);
    expect(logged).not.toContain("Private");
    expect(logged).not.toContain("secretpath");
    expect(logged).not.toContain("U0456DEF");
    expect(logged).not.toContain(TEAM);
  });
});
