import { describe, expect, it } from "vitest";
import type { AccessInputError } from "@/lib/access-requests/input";
import {
  accessReplyText,
  type AccessSubmitOutcome,
} from "@/lib/access-requests/replies";

const accountUrl = "https://auth.example.test/account";
const reply = (outcome: AccessSubmitOutcome) =>
  accessReplyText(outcome, { accountUrl });

describe("accessReplyText", () => {
  it("puts the copy string in a code block on success", () => {
    const text = reply({
      status: "submitted",
      requestId: "r1",
      copy: "Access request: A <b> & C",
    });
    expect(text).toContain("Nothing is granted automatically.");
    expect(text).toContain("```Access request: A &lt;b&gt; &amp; C```");
  });

  it("links the account page when not linked", () => {
    expect(reply({ status: "not_linked" })).toBe(
      `Your Slack account isn't linked to SGAuth. Link it under *Connect Slack* on <${accountUrl}|your SGAuth account>, then try again.`,
    );
  });

  it("explains an inactive account", () => {
    expect(reply({ status: "inactive" })).toBe(
      "Your SGAuth account isn't active, so you can't submit access requests.",
    );
  });

  it("reuses the shared denial copy for a non-submitter", () => {
    expect(reply({ status: "not_submitter" })).toBe(
      "Your position can't submit access requests. If you think it should, ask an SGAuth admin.",
    );
  });

  it.each<[AccessInputError, string]>([
    ["usage", "Usage: `/access &lt;product&gt; | &lt;access you need&gt;`"],
    ["missing_part", "Both parts are needed: the product before the |"],
    ["product_too_long", "The product name can be at most 100 characters."],
    [
      "access_too_long",
      "The access description can be at most 500 characters.",
    ],
    ["bad_characters", "Remove backticks (`) and special characters"],
  ])("explains an invalid input: %s", (error, expected) => {
    expect(reply({ status: "invalid", error })).toContain(expected);
  });

  it("shows the example in both usage replies", () => {
    for (const error of ["usage", "missing_part"] as const) {
      expect(reply({ status: "invalid", error })).toContain(
        "Example: `/access Notion | Edit access to the Finance workspace`",
      );
    }
  });
});
