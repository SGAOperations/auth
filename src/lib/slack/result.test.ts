import { describe, expect, it } from "vitest";
import { slackLinkUrl } from "@/lib/slack/links";
import {
  SLACK_RESULTS,
  slackResultMessage,
  slackResultPath,
  type SlackResult,
} from "@/lib/slack/result";

describe("slack results", () => {
  it("round-trips every result through the account page", () => {
    for (const result of Object.keys(SLACK_RESULTS) as SlackResult[]) {
      const url = new URL(slackResultPath(result), "https://auth.example");
      expect(url.pathname).toBe("/account");
      expect(url.hash).toBe("#slack");
      expect(
        slackResultMessage(url.searchParams.get("slack") ?? undefined),
      ).toEqual({ result, message: SLACK_RESULTS[result] });
    }
  });

  it.each([undefined, "", "constructor", "toString", "nope"])(
    "shows nothing for %s",
    (value) => {
      expect(slackResultMessage(value)).toBeNull();
    },
  );

  it("shows nothing for a repeated parameter", () => {
    expect(slackResultMessage(["linked", "linked"])).toBeNull();
  });
});

describe("slackLinkUrl", () => {
  it("puts the token in the query of the link page", () => {
    const url = new URL(slackLinkUrl("https://auth.example", "a_b-c"));
    expect(url.origin).toBe("https://auth.example");
    expect(url.pathname).toBe("/account/slack/link");
    expect(url.searchParams.get("token")).toBe("a_b-c");
  });
});
