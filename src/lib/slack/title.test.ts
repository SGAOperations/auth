import { describe, expect, it } from "vitest";
import {
  SLACK_TITLE_MAX_LENGTH,
  SLACK_TITLE_SEPARATOR,
  leadershipTitle,
  type TitlePosition,
} from "@/lib/slack/title";

const lead = (key: string, name: string): TitlePosition => ({
  key,
  name,
  isLeadership: true,
});
const member = (key: string, name: string): TitlePosition => ({
  key,
  name,
  isLeadership: false,
});

describe("leadershipTitle", () => {
  it("gives an empty title for no positions", () => {
    expect(leadershipTitle([])).toEqual({ ok: true, title: "" });
  });

  it("gives an empty title for only non-leadership positions", () => {
    expect(
      leadershipTitle([member("m", "Member"), member("s", "Staff")]),
    ).toEqual({ ok: true, title: "" });
  });

  it("gives the name alone for one leadership position", () => {
    expect(leadershipTitle([lead("pres", "President")])).toEqual({
      ok: true,
      title: "President",
    });
  });

  it("joins several leadership positions with the separator", () => {
    expect(
      leadershipTitle([lead("a", "Chair"), lead("b", "Treasurer")]),
    ).toEqual({ ok: true, title: `Chair${SLACK_TITLE_SEPARATOR}Treasurer` });
    expect(SLACK_TITLE_SEPARATOR).toBe(" | ");
  });

  it("orders by name regardless of input order", () => {
    const forward = [
      lead("a", "Chair"),
      lead("b", "Director"),
      lead("c", "Vice"),
    ];
    const reversed = [...forward].reverse();
    const expected = { ok: true, title: "Chair | Director | Vice" };
    expect(leadershipTitle(forward)).toEqual(expected);
    expect(leadershipTitle(reversed)).toEqual(expected);
    expect(leadershipTitle([forward[1], forward[2], forward[0]])).toEqual(
      expected,
    );
  });

  it("orders positions with the same name by key", () => {
    const first = leadershipTitle([lead("b", "Chair"), lead("a", "Chair")]);
    const second = leadershipTitle([lead("a", "Chair"), lead("b", "Chair")]);
    expect(first).toEqual(second);
    expect(first).toEqual({ ok: true, title: "Chair | Chair" });
  });

  it("never includes non-leadership positions", () => {
    const result = leadershipTitle([
      member("m", "Member"),
      lead("pres", "President"),
      member("s", "Staff"),
      lead("tre", "Treasurer"),
    ]);
    expect(result).toEqual({ ok: true, title: "President | Treasurer" });
  });

  it("accepts a title of exactly the limit", () => {
    const result = leadershipTitle([
      lead("a", "x".repeat(SLACK_TITLE_MAX_LENGTH)),
    ]);
    expect(result.ok).toBe(true);
  });

  it("refuses a title one over the limit, with the length and reason", () => {
    const result = leadershipTitle([
      lead("a", "x".repeat(SLACK_TITLE_MAX_LENGTH + 1)),
    ]);
    expect(result).toEqual({
      ok: false,
      length: SLACK_TITLE_MAX_LENGTH + 1,
      reason: `Leadership title is ${SLACK_TITLE_MAX_LENGTH + 1} characters; Slack allows at most ${SLACK_TITLE_MAX_LENGTH}.`,
    });
  });

  it("counts the separators toward the limit", () => {
    const half = "x".repeat((SLACK_TITLE_MAX_LENGTH - 3) / 2);
    expect(leadershipTitle([lead("a", half), lead("b", `${half}y`)]).ok).toBe(
      false,
    );
    expect(leadershipTitle([lead("a", half), lead("b", half)]).ok).toBe(true);
  });

  it("counts code points, not UTF-16 units", () => {
    const name = "😀".repeat(SLACK_TITLE_MAX_LENGTH);
    expect(name.length).toBeGreaterThan(SLACK_TITLE_MAX_LENGTH);
    expect(leadershipTitle([lead("a", name)])).toEqual({
      ok: true,
      title: name,
    });
    expect(leadershipTitle([lead("a", `${name}😀`)]).ok).toBe(false);
  });

  it("does not change the input array", () => {
    const input = [
      lead("b", "Treasurer"),
      member("m", "Member"),
      lead("a", "Chair"),
    ];
    const snapshot = [...input];
    leadershipTitle(input);
    expect(input).toEqual(snapshot);
  });
});
