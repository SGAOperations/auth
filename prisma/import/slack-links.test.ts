import { describe, expect, it } from "vitest";
import { UsageError } from "../seed/sync-env";
import { ImportInputError } from "./chambers";
import {
  buildSlackLinkReport,
  parseSlackLinkImportArgs,
  planSlackLinkImport,
  validateSlackLinkSource,
  type SlackLinkState,
} from "./slack-links";

const TEAM = "T0SGA";
const A = "0192f0a0-0000-7000-8000-00000000000a";
const B = "0192f0a0-0000-7000-8000-00000000000b";
const C = "0192f0a0-0000-7000-8000-00000000000c";
const D = "0192f0a0-0000-7000-8000-00000000000d";
const E = "0192f0a0-0000-7000-8000-00000000000e";

function state(overrides: Partial<SlackLinkState> = {}): SlackLinkState {
  return {
    users: new Map(),
    byUser: new Map(),
    bySlack: new Map(),
    ...overrides,
  };
}

describe("parseSlackLinkImportArgs", () => {
  it("reads a dry run and an apply", () => {
    expect(
      parseSlackLinkImportArgs([
        "--source",
        "f.json",
        "--team",
        TEAM,
        "--dry-run",
      ]),
    ).toEqual({ source: "f.json", team: TEAM, apply: false });
    expect(
      parseSlackLinkImportArgs([
        "--apply",
        "--team",
        TEAM,
        "--source",
        "f.json",
      ]),
    ).toEqual({ source: "f.json", team: TEAM, apply: true });
  });

  it.each([
    [["--team", TEAM, "--dry-run"]],
    [["--source", "f.json", "--dry-run"]],
    [["--source", "f.json", "--team", "U0NOTATEAM", "--dry-run"]],
    [["--source", "f.json", "--team", TEAM]],
    [["--source", "f.json", "--team", TEAM, "--dry-run", "--apply"]],
    [["--source", "f.json", "--team", TEAM, "--dry-run", "--force"]],
  ])("refuses %j", (argv) => {
    expect(() => parseSlackLinkImportArgs(argv)).toThrow(UsageError);
  });
});

describe("validateSlackLinkSource", () => {
  it("accepts the export's shape", () => {
    const rows = [{ sgauthUserId: A, slackUserId: "U0A" }];
    expect(validateSlackLinkSource(rows)).toEqual(rows);
  });

  it.each([
    [{ rows: [] }],
    [[{ sgauthUserId: "not-a-uuid", slackUserId: "U0A" }]],
    [[{ sgauthUserId: A, slackUserId: "T0A" }]],
    [[{ sgauthUserId: A, slackUserId: "U0A", email: "x@y.z" }]],
  ])("refuses %j", (raw) => {
    expect(() => validateSlackLinkSource(raw)).toThrow(ImportInputError);
  });

  it("refuses a user or a Slack account listed twice", () => {
    expect(() =>
      validateSlackLinkSource([
        { sgauthUserId: A, slackUserId: "U0A" },
        { sgauthUserId: A, slackUserId: "U0B" },
      ]),
    ).toThrow(ImportInputError);
    expect(() =>
      validateSlackLinkSource([
        { sgauthUserId: A, slackUserId: "U0A" },
        { sgauthUserId: B, slackUserId: "U0A" },
      ]),
    ).toThrow(ImportInputError);
  });
});

describe("planSlackLinkImport", () => {
  const rows = [
    { sgauthUserId: A, slackUserId: "U0A" },
    { sgauthUserId: B, slackUserId: "U0B" },
    { sgauthUserId: C, slackUserId: "U0C" },
    { sgauthUserId: D, slackUserId: "U0D" },
    { sgauthUserId: E, slackUserId: "U0E" },
  ];

  it("links the new, keeps the same, and never overwrites", () => {
    const plan = planSlackLinkImport(
      TEAM,
      rows,
      state({
        users: new Map([
          [A, "ACTIVE"],
          [B, "ACTIVE"],
          [C, "DEACTIVATED"],
          [D, "DELETED"],
          // E is unknown.
        ]),
        byUser: new Map([[B, { slackTeamId: TEAM, slackUserId: "U0B" }]]),
        // Someone else linked C's Slack account since the export.
        bySlack: new Map([
          ["U0B", B],
          ["U0C", E],
        ]),
      }),
    );
    expect(plan.rows.map((entry) => entry.outcome)).toEqual([
      "link",
      "unchanged",
      "conflict",
      "missing_user",
      "missing_user",
    ]);
    expect(plan.counts).toEqual({
      link: 1,
      unchanged: 1,
      conflict: 1,
      missing_user: 2,
    });
  });

  it("reports a user who linked a different Slack account", () => {
    const plan = planSlackLinkImport(
      TEAM,
      [{ sgauthUserId: A, slackUserId: "U0A" }],
      state({
        users: new Map([[A, "ACTIVE"]]),
        byUser: new Map([[A, { slackTeamId: TEAM, slackUserId: "U0OTHER" }]]),
      }),
    );
    expect(plan.rows[0].outcome).toBe("conflict");
  });

  it("writes a report with SGAuth ids and outcomes only", () => {
    const plan = planSlackLinkImport(
      TEAM,
      [{ sgauthUserId: A, slackUserId: "U0SECRET" }],
      state(),
    );
    const report = buildSlackLinkReport(plan, {
      generatedAt: new Date("2026-11-01T00:00:00Z"),
      target: "branch",
      sourceSha256: "0".repeat(64),
      dryRun: true,
    });
    expect(report.notLinked).toEqual([
      { sgauthUserId: A, outcome: "missing_user" },
    ]);
    expect(JSON.stringify(report)).not.toContain("U0SECRET");
  });
});
