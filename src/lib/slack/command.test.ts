import { describe, expect, it } from "vitest";
import {
  codeBlock,
  decodeSlackText,
  ephemeral,
  escapeSlackText,
  isSlackResponseUrl,
  parseSlackCommandBody,
} from "@/lib/slack/command";

const form = (fields: Record<string, string>) =>
  new URLSearchParams(fields).toString();

const valid = {
  command: "/access",
  team_id: "T0123ABC",
  user_id: "U0456DEF",
  text: "Notion | Edit",
  response_url: "https://hooks.slack.com/commands/T0123ABC/1/xyz",
};

describe("parseSlackCommandBody", () => {
  it("parses a body and keeps the extra fields", () => {
    const result = parseSlackCommandBody(
      form({ ...valid, channel_id: "C1", trigger_id: "t" }),
    );
    expect(result.success).toBe(true);
    expect(result.data).toMatchObject({
      ...valid,
      channel_id: "C1",
      trigger_id: "t",
    });
  });

  it("defaults a missing text to empty", () => {
    const rest: Record<string, string> = { ...valid };
    delete rest.text;
    expect(parseSlackCommandBody(form(rest)).data?.text).toBe("");
  });

  it.each([
    ["a bad user id", { user_id: "u0456" }],
    ["a bad team id", { team_id: "E0123" }],
    ["a missing command", { command: undefined }],
    ["a bad response_url", { response_url: "not a url" }],
    ["a long text", { text: "x".repeat(4001) }],
  ])("rejects %s", (_label, change) => {
    const body = { ...valid, ...change };
    const defined = Object.fromEntries(
      Object.entries(body).filter(([, value]) => value !== undefined),
    ) as Record<string, string>;
    expect(parseSlackCommandBody(form(defined)).success).toBe(false);
  });
});

describe("isSlackResponseUrl", () => {
  it("accepts a hooks.slack.com URL", () => {
    expect(
      isSlackResponseUrl("https://hooks.slack.com/commands/T1/2/abc"),
    ).toBe(true);
  });

  it.each([
    ["http", "http://hooks.slack.com/commands/T1/2/abc"],
    ["another host", "https://example.test/commands"],
    ["a suffixed host", "https://hooks.slack.com.evil.test/x"],
    ["a prefixed host", "https://evil-hooks.slack.com/x"],
    ["a subdomain", "https://a.hooks.slack.com/x"],
    ["userinfo", "https://hooks.slack.com@evil.test/x"],
    ["credentials", "https://user:pw@hooks.slack.com/x"],
    ["garbage", "not a url"],
  ])("rejects %s", (_label, url) => {
    expect(isSlackResponseUrl(url)).toBe(false);
  });
});

describe("Slack text escaping", () => {
  it("round-trips", () => {
    const text = "a & b < c > d &amp; &lt;";
    expect(decodeSlackText(escapeSlackText(text))).toBe(text);
  });

  it("decodes in one pass", () => {
    expect(decodeSlackText("&amp;lt;")).toBe("&lt;");
    expect(decodeSlackText("&lt;&gt;&amp;")).toBe("<>&");
  });

  it("wraps escaped text in a code block", () => {
    expect(codeBlock("a < b & c")).toBe("```a &lt; b &amp; c```");
  });

  it("builds an ephemeral reply", () => {
    expect(ephemeral("hi")).toEqual({ response_type: "ephemeral", text: "hi" });
  });
});
