import { describe, expect, it, vi } from "vitest";
import { slackSignature } from "./signature";
import {
  createWhoIsHandler,
  escapeSlackText,
  parseMention,
  renderWhoIsReply,
  sortWhoIsPositions,
  type WhoIsHandlerDeps,
  type WhoIsPosition,
  type WhoIsResult,
} from "./who-is";

const SECRET = "test-signing-secret";
const NOW = new Date("2026-01-01T00:00:00Z");
const TIMESTAMP = String(Math.floor(NOW.getTime() / 1000));
const TEAM = "T0SGA";
const CALLER = "U0CALLER";
const TARGET = "U0456";
const ACCOUNT_URL = "https://auth.example.test/account/slack";

function signedRequest(
  fields: Record<string, string>,
  opts: { signature?: string; timestamp?: string } = {},
): Request {
  const body = new URLSearchParams(fields).toString();
  const timestamp = opts.timestamp ?? TIMESTAMP;
  return new Request("https://auth.example.test/api/slack/commands/who-is", {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      "x-slack-request-timestamp": timestamp,
      "x-slack-signature":
        opts.signature ?? slackSignature(SECRET, timestamp, body),
    },
    body,
  });
}

const command = (text: string, extra: Record<string, string> = {}) =>
  signedRequest({
    team_id: TEAM,
    user_id: CALLER,
    command: "/who-is",
    text,
    ...extra,
  });

function setup(result: WhoIsResult, overrides: Partial<WhoIsHandlerDeps> = {}) {
  const lookup = vi.fn().mockResolvedValue(result);
  const log = { warn: vi.fn(), error: vi.fn() };
  const handler = createWhoIsHandler({
    signingSecret: SECRET,
    teamId: TEAM,
    accountUrl: ACCOUNT_URL,
    lookup,
    log,
    now: () => NOW,
    ...overrides,
  });
  return { handler, lookup, log };
}

async function reply(res: Response): Promise<string> {
  const body = (await res.json()) as { response_type: string; text: string };
  expect(res.status).toBe(200);
  expect(body.response_type).toBe("ephemeral");
  expect(res.headers.get("Cache-Control")).toBe("no-store");
  return body.text;
}

const position = (overrides: Partial<WhoIsPosition> = {}): WhoIsPosition => ({
  name: "Treasurer",
  category: "Finance",
  isLeadership: false,
  manager: null,
  ...overrides,
});

const found = (positions: WhoIsPosition[], name = "Jane Doe"): WhoIsResult => ({
  kind: "found",
  name,
  positions,
});

describe("parseMention", () => {
  it.each([
    ["<@U0456>", "U0456"],
    ["<@U0456|jane>", "U0456"],
    ["  <@W0456>  ", "W0456"],
  ])("accepts %s", (text, id) => {
    expect(parseMention(text)).toBe(id);
  });

  it.each([
    "",
    "@jane",
    "jane",
    "<@U0456> <@U0789>",
    "<@U0456> please",
    "<#C0456>",
    "<@u0456>",
    "<@U0456|a>b>",
  ])("rejects %j", (text) => {
    expect(parseMention(text)).toBeNull();
  });
});

describe("escapeSlackText", () => {
  it("escapes & before < and >", () => {
    expect(escapeSlackText("a & <b> &lt;")).toBe("a &amp; &lt;b&gt; &amp;lt;");
  });
});

describe("sortWhoIsPositions", () => {
  it("orders by category, uncategorized last, then by name", () => {
    const sorted = sortWhoIsPositions([
      position({ name: "Z", category: null }),
      position({ name: "B", category: "Finance" }),
      position({ name: "A", category: "Finance" }),
      position({ name: "C", category: "Executive Board" }),
      position({ name: "A", category: null }),
    ]);
    expect(sorted.map((p) => `${p.category}/${p.name}`)).toEqual([
      "Executive Board/C",
      "Finance/A",
      "Finance/B",
      "null/A",
      "null/Z",
    ]);
  });
});

describe("renderWhoIsReply", () => {
  const ctx = { targetSlackUserId: TARGET, accountUrl: ACCOUNT_URL };

  it("renders two positions, one with a manager and one without", () => {
    const text = renderWhoIsReply(
      found([
        position({
          name: "Vice President of Finance",
          category: "Executive Board",
          isLeadership: true,
          manager: { name: "President", category: "Executive Board" },
        }),
        position(),
      ]),
      ctx,
    );
    expect(text).toBe(
      [
        "*Jane Doe* (<@U0456>) holds 2 positions:",
        "• *Vice President of Finance* · Executive Board · Leadership position",
        "    Reports to: President (Executive Board)",
        "• *Treasurer* · Finance · Not a leadership position",
        "    Reports to: no manager position set",
      ].join("\n"),
    );
  });

  it("says 1 position for one", () => {
    expect(renderWhoIsReply(found([position()]), ctx)).toContain(
      "holds 1 position:",
    );
  });

  it("leaves the category out when it is null, on both lines", () => {
    const text = renderWhoIsReply(
      found([
        position({
          category: null,
          manager: { name: "President", category: null },
        }),
      ]),
      ctx,
    );
    expect(text).toContain("• *Treasurer* · Not a leadership position");
    expect(text.split("\n")[2]).toBe("    Reports to: President");
  });

  it("answers a person with no positions", () => {
    expect(renderWhoIsReply(found([]), ctx)).toBe(
      "*Jane Doe* (<@U0456>) doesn't hold any positions in SGAuth.",
    );
  });

  it("escapes names, categories and the manager", () => {
    const text = renderWhoIsReply(
      found(
        [
          position({
            name: "R&D <lead>",
            category: "A>B",
            manager: { name: "<!channel>", category: "&" },
          }),
        ],
        "<b>Jane</b>",
      ),
      ctx,
    );
    expect(text).toContain("*&lt;b&gt;Jane&lt;/b&gt;*");
    expect(text).toContain("*R&amp;D &lt;lead&gt;* · A&gt;B");
    expect(text).toContain("&lt;!channel&gt; (&amp;)");
    expect(text).not.toContain("<!channel>");
  });

  it("points an unlinked target and an unlinked caller at the account page", () => {
    const target = renderWhoIsReply({ kind: "target_unlinked" }, ctx);
    expect(target).toContain("<@U0456> hasn't linked");
    expect(target).toContain(`<${ACCOUNT_URL}|their SGAuth account page>`);

    const caller = renderWhoIsReply({ kind: "caller_unlinked" }, ctx);
    expect(caller).toContain("Link your Slack account to SGAuth");
    expect(caller).toContain(`<${ACCOUNT_URL}|your SGAuth account page>`);
  });
});

describe("createWhoIsHandler", () => {
  it("replies with the positions of a linked person", async () => {
    const { handler, lookup } = setup(found([position()]));
    const text = await reply(await handler(command(`<@${TARGET}>`)));
    expect(text).toContain("*Jane Doe* (<@U0456>) holds 1 position:");
    expect(lookup).toHaveBeenCalledWith({
      slackTeamId: TEAM,
      callerSlackUserId: CALLER,
      targetSlackUserId: TARGET,
    });
  });

  it("accepts the <@U…|name> form", async () => {
    const { handler, lookup } = setup(found([]));
    await reply(await handler(command(`<@${TARGET}|jane>`)));
    expect(lookup).toHaveBeenCalledOnce();
  });

  it("replies for an unlinked target and an unlinked caller", async () => {
    for (const kind of ["target_unlinked", "caller_unlinked"] as const) {
      const { handler } = setup({ kind });
      const text = await reply(await handler(command(`<@${TARGET}>`)));
      expect(text).toContain("/account/slack");
    }
  });

  it("answers an unsigned request with a bare 401 and no lookup", async () => {
    const { handler, lookup, log } = setup(found([]));
    const req = new Request("https://auth.example.test/x", {
      method: "POST",
      body: "team_id=T0SGA",
    });
    const res = await handler(req);
    expect(res.status).toBe(401);
    expect(await res.json()).toEqual({ error: "unauthorized" });
    expect(lookup).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("slack_command.unverified", {
      command: "who-is",
      reason: "missing_headers",
    });
  });

  it("answers a bad signature with 401 and no lookup", async () => {
    const { handler, lookup } = setup(found([]));
    const res = await handler(
      signedRequest(
        { team_id: TEAM, user_id: CALLER, text: `<@${TARGET}>` },
        { signature: "v0=00" },
      ),
    );
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("answers a stale request with 401", async () => {
    const { handler, lookup } = setup(found([]));
    const stale = String(Math.floor(NOW.getTime() / 1000) - 3600);
    const res = await handler(
      signedRequest(
        { team_id: TEAM, user_id: CALLER, text: `<@${TARGET}>` },
        { timestamp: stale },
      ),
    );
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("refuses everything when the secret is unset", async () => {
    const { handler, lookup } = setup(found([]), { signingSecret: undefined });
    const res = await handler(command(`<@${TARGET}>`));
    expect(res.status).toBe(401);
    expect(lookup).not.toHaveBeenCalled();
  });

  it("answers Slack's ssl_check with an empty 200", async () => {
    const { handler, lookup } = setup(found([]));
    const res = await handler(signedRequest({ ssl_check: "1" }));
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("replies to an unreadable payload", async () => {
    const { handler, lookup } = setup(found([]));
    const text = await reply(
      await handler(signedRequest({ team_id: "nope", user_id: CALLER })),
    );
    expect(text).toBe("Sorry, that command couldn't be read. Try again.");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("replies to another workspace", async () => {
    const { handler, lookup } = setup(found([]));
    const text = await reply(
      await handler(command(`<@${TARGET}>`, { team_id: "T0OTHER" })),
    );
    expect(text).toBe("/who-is only works in the SGA Slack workspace.");
    expect(lookup).not.toHaveBeenCalled();
  });

  it("accepts any workspace when none is configured", async () => {
    const { handler, lookup } = setup(found([]), { teamId: undefined });
    await reply(await handler(command(`<@${TARGET}>`, { team_id: "T0OTHER" })));
    expect(lookup).toHaveBeenCalledOnce();
  });

  it.each(["", "@jane", `<@${TARGET}> <@U0789>`])(
    "replies with usage for %j",
    async (text) => {
      const { handler, lookup } = setup(found([]));
      const body = await reply(await handler(command(text)));
      expect(body).toBe(
        "Usage: `/who-is @person`. Mention exactly one person.",
      );
      expect(lookup).not.toHaveBeenCalled();
    },
  );

  it("answers a throwing lookup with the generic reply and one error log", async () => {
    const err = new Error("db down");
    const { handler, log } = setup(found([]), {
      lookup: () => Promise.reject(err),
    });
    const text = await reply(await handler(command(`<@${TARGET}>`)));
    expect(text).toBe(
      "Something went wrong looking that up. Try again in a minute.",
    );
    expect(log.error).toHaveBeenCalledOnce();
    expect(log.error).toHaveBeenCalledWith("slack_command.failed", {
      command: "who-is",
      err,
    });
  });
});
