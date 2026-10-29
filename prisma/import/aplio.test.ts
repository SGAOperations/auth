import { describe, expect, it } from "vitest";
import { planAplioImport, type AplioRow } from "@/lib/import/aplio";
import { UsageError } from "../seed/sync-env";
import {
  buildAplioIdMap,
  buildAplioReport,
  buildReconcileReport,
  formatAplioSummary,
  formatReconcileSummary,
  parseAplioImportArgs,
  parseAplioReconcileArgs,
} from "./aplio";
import { reconcileAplio } from "@/lib/import/aplio-reconcile";

const NOW = new Date("2026-11-01T12:00:00Z");
const CUTOVER = new Date("2026-12-01T10:00:00Z");
const ID = "0192f1a0-0000-7000-8000-000000000001";

function row(overrides: Partial<AplioRow> = {}): AplioRow {
  return {
    aplioId: "a1",
    email: "ada@northeastern.edu",
    name: "Ada",
    isAdmin: false,
    deletedAt: null,
    sgauthUserId: null,
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

describe("parseAplioImportArgs", () => {
  it("needs a source and exactly one mode", () => {
    expect(() => parseAplioImportArgs(["--dry-run"])).toThrow(UsageError);
    expect(() => parseAplioImportArgs(["--source", "x.json"])).toThrow(
      "exactly one",
    );
    expect(() =>
      parseAplioImportArgs(["--source", "x.json", "--dry-run", "--apply"]),
    ).toThrow("exactly one");
  });

  it("rejects an unknown or repeated flag", () => {
    expect(() =>
      parseAplioImportArgs(["--source", "x", "--dry-run", "--mapping", "m"]),
    ).toThrow("Unknown argument");
    expect(() =>
      parseAplioImportArgs(["--source", "x", "--source", "y", "--dry-run"]),
    ).toThrow("more than once");
  });

  it("defaults --out to a stamped directory under .temp", () => {
    const args = parseAplioImportArgs(["--source", "x", "--apply"], NOW);
    expect(args).toEqual({
      source: "x",
      apply: true,
      out: ".temp/aplio-import/20261101-120000",
    });
  });
});

describe("parseAplioReconcileArgs", () => {
  it("requires --cutover-at", () => {
    expect(() => parseAplioReconcileArgs(["--source", "x"])).toThrow(
      "--cutover-at is required",
    );
  });

  it("rejects a cutover without an offset", () => {
    expect(() =>
      parseAplioReconcileArgs([
        "--source",
        "x",
        "--cutover-at",
        "2026-12-01T05:00:00",
      ]),
    ).toThrow("with an offset");
  });

  it("parses the instant", () => {
    const args = parseAplioReconcileArgs(
      ["--source", "x", "--cutover-at", "2026-12-01T05:00:00-05:00"],
      NOW,
    );
    expect(args.cutoverAt.toISOString()).toBe("2026-12-01T10:00:00.000Z");
    expect(args.out).toBe(".temp/aplio-reconcile/20261101-120000");
  });
});

describe("import output", () => {
  const rows = [
    row(),
    row({ aplioId: "a2", email: "old@gmail.com", isAdmin: true }),
    row({
      aplioId: "a3",
      email: "gone@northeastern.edu",
      deletedAt: "2025-01-01T00:00:00Z",
    }),
  ];
  const plan = planAplioImport(rows, state());

  it("lists every legacy account in the report", () => {
    const report = buildAplioReport(plan, {
      generatedAt: NOW,
      dryRun: true,
      target: "host/db",
      sourceSha256: "a".repeat(64),
    });
    expect(report.legacyEmails).toEqual([
      { aplioId: "a2", email: "old@gmail.com", outcome: "create" },
    ]);
    expect(report.rows).toHaveLength(3);
    expect(report.counts).toMatchObject({
      create: 2,
      skip: 1,
      legacyEmails: 1,
    });
  });

  it("maps every non-skipped row and never a skipped one", () => {
    const applied = {
      ...plan,
      rows: plan.rows.map((entry, index) =>
        entry.outcome === "create"
          ? { ...entry, userId: `id-${index}` }
          : entry,
      ),
    };
    const map = buildAplioIdMap(applied, {
      generatedAt: NOW,
      sourceSha256: "a".repeat(64),
    });
    expect(map.mappings).toEqual([
      { aplioId: "a1", sgauthId: "id-0", outcome: "create" },
      { aplioId: "a2", sgauthId: "id-1", outcome: "create" },
    ]);
  });

  it("prints ids and counts, never an address or a name", () => {
    const summary = formatAplioSummary(plan);
    expect(summary).toContain("! skip a3 soft-deleted in Aplio");
    expect(summary).toContain("1 accounts are outside @northeastern.edu");
    expect(summary).toContain("3 rows: 2 create");
    expect(summary).not.toMatch(/ada@|old@|gone@|Ada/);
  });
});

describe("reconcile output", () => {
  const liveRows = [row({ sgauthUserId: ID })];

  it("ends with READY when nothing blocks", () => {
    const result = reconcileAplio(
      liveRows,
      state([["ada@northeastern.edu", ID]]),
      [],
      NOW,
      CUTOVER,
    );
    const summary = formatReconcileSummary(result, NOW, CUTOVER);
    expect(summary.split("\n").at(-1)).toBe(
      "READY: switch reads at 2026-12-01T10:00:00.000Z",
    );
    expect(summary).toContain("718h 0m until the cutover");
  });

  it("ends with NOT READY and a fix per blocking category", () => {
    const result = reconcileAplio(liveRows, state(), [], NOW, CUTOVER);
    const summary = formatReconcileSummary(result, NOW, CUTOVER);
    expect(summary).toContain("! missing-in-sgauth: re-run import:aplio");
    expect(summary.split("\n").at(-1)).toBe("NOT READY: 1 missing-in-sgauth");
  });

  it("never prints READY after the cutover", () => {
    const after = new Date(CUTOVER.getTime() + 1000);
    const result = reconcileAplio(
      liveRows,
      state([["ada@northeastern.edu", ID]]),
      [],
      after,
      CUTOVER,
    );
    const summary = formatReconcileSummary(result, after, CUTOVER);
    expect(summary).not.toMatch(/^READY:/m);
    expect(summary).toContain("the cutover has passed");
    expect(summary.split("\n").at(-1)).toBe("NOT READY: cutover has passed");
  });

  it("holds the verdict and the review list in the report", () => {
    const result = reconcileAplio(
      [],
      state(),
      [{ userId: ID, email: "stray@northeastern.edu" }],
      NOW,
      CUTOVER,
    );
    const report = buildReconcileReport(result, {
      generatedAt: NOW,
      target: "host/db",
      sourceSha256: "a".repeat(64),
      cutoverAt: CUTOVER,
    });
    expect(report).toMatchObject({
      ready: true,
      sgauthOnly: [{ userId: ID, email: "stray@northeastern.edu" }],
    });
  });
});
