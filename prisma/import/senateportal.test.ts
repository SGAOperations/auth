import { describe, expect, it } from "vitest";
import {
  planSenatePortalImport,
  type SenatePortalRow,
} from "@/lib/import/senateportal";
import { UsageError } from "../seed/sync-env";
import {
  buildSenatePortalIdMap,
  buildSenatePortalReport,
  formatSenatePortalSummary,
  parseSenatePortalImportArgs,
} from "./senateportal";

const NOW = new Date("2026-11-01T12:00:00Z");
const ID = "0192f1a0-0000-7000-8000-000000000001";

function row(overrides: Partial<SenatePortalRow> = {}): SenatePortalRow {
  return {
    senatePortalId: "p1",
    email: "ada@northeastern.edu",
    name: "Ada Lovelace",
    deletedAt: null,
    ...overrides,
  };
}

const state = (users: [string, string][] = []) => ({
  users: new Map(
    users.map(([email, id]) => [
      email,
      { id, status: "ACTIVE" as const, emailVerified: true },
    ]),
  ),
});

describe("parseSenatePortalImportArgs", () => {
  it("needs a source and exactly one mode", () => {
    expect(() => parseSenatePortalImportArgs(["--dry-run"])).toThrow(
      UsageError,
    );
    expect(() => parseSenatePortalImportArgs(["--source", "x.json"])).toThrow(
      "exactly one",
    );
    expect(() =>
      parseSenatePortalImportArgs([
        "--source",
        "x.json",
        "--dry-run",
        "--apply",
      ]),
    ).toThrow("exactly one");
  });

  it("rejects a --mapping flag: this import assigns no positions", () => {
    expect(() =>
      parseSenatePortalImportArgs([
        "--source",
        "x",
        "--dry-run",
        "--mapping",
        "m",
      ]),
    ).toThrow("Unknown argument");
  });

  it("defaults --out to a stamped directory under .temp", () => {
    expect(
      parseSenatePortalImportArgs(["--source", "x", "--apply"], NOW),
    ).toEqual({
      source: "x",
      apply: true,
      out: ".temp/senateportal-import/20261101-120000",
    });
  });
});

describe("import output", () => {
  const rows = [
    row(),
    row({ senatePortalId: "p2", email: "old@gmail.com" }),
    row({
      senatePortalId: "p3",
      email: "gone@northeastern.edu",
      deletedAt: "2025-01-01T00:00:00Z",
    }),
    row({ senatePortalId: "p4", email: "grace@northeastern.edu" }),
  ];
  const plan = planSenatePortalImport(
    rows,
    state([["grace@northeastern.edu", ID]]),
  );

  it("lists every legacy account and the dropped column names in the report", () => {
    const report = buildSenatePortalReport(plan, {
      generatedAt: NOW,
      dryRun: true,
      target: "host/db",
      sourceSha256: "a".repeat(64),
      droppedColumns: ["nuid"],
    });
    expect(report.droppedColumns).toEqual(["nuid"]);
    expect(report.legacyEmails).toEqual([
      { senatePortalId: "p2", email: "old@gmail.com", outcome: "create" },
    ]);
    expect(report.rows).toHaveLength(4);
  });

  it("maps merged rows and leaves out skipped and unapplied ones", () => {
    const idMap = buildSenatePortalIdMap(plan, {
      generatedAt: NOW,
      sourceSha256: "a".repeat(64),
    });
    // The two creates have no id until apply fills them in.
    expect(idMap.mappings).toEqual([
      { senatePortalId: "p4", sgauthId: ID, outcome: "merge" },
    ]);
    expect(JSON.stringify(idMap)).not.toContain("@");
  });

  it("summarises with ids and counts only, never an address or a name", () => {
    const summary = formatSenatePortalSummary(plan, ["nuid"]);
    expect(summary).toContain("dropped columns not in the contract: nuid");
    expect(summary).toContain("! skip p3 soft-deleted in SenatePortal");
    expect(summary).toContain(
      "4 rows: 2 create, 1 merge, 0 duplicate in source, 1 skip; 0 names defaulted; no positions assigned",
    );
    for (const address of ["ada@", "old@", "gone@", "grace@"]) {
      expect(summary).not.toContain(address);
    }
    expect(summary).not.toContain("Lovelace");
  });
});
