import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import type { AplioExisting, AplioState } from "@/lib/import/aplio";
import {
  planSenatePortalImport,
  validateSenatePortalExport,
  type SenatePortalRow,
} from "@/lib/import/senateportal";

const ID_A = "0192f1a0-0000-7000-8000-000000000001";
const NUID = "002947183";

function row(overrides: Partial<SenatePortalRow> = {}): SenatePortalRow {
  return {
    senatePortalId: "p1",
    email: "ada@northeastern.edu",
    name: "Ada Lovelace",
    deletedAt: null,
    ...overrides,
  };
}

function stateOf(users: Record<string, AplioExisting> = {}): AplioState {
  return { users: new Map(Object.entries(users)) };
}

const verified = (id: string, status: AplioExisting["status"] = "ACTIVE") => ({
  id,
  status,
  emailVerified: true,
});

describe("validateSenatePortalExport", () => {
  const file = (rows: unknown) => JSON.stringify(rows);
  const base = {
    id: "p1",
    email: "Ada@Northeastern.edu ",
    firstName: " Ada",
    lastName: "Lovelace ",
    deletedAt: null,
  };

  it("parses rows, joining the name, normalising the address and hashing the bytes", () => {
    const result = validateSenatePortalExport(file([base]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows).toEqual([
      {
        senatePortalId: "p1",
        email: "ada@northeastern.edu",
        name: "Ada Lovelace",
        deletedAt: null,
      },
    ]);
    expect(result.droppedColumns).toEqual([]);
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("maps blank first and last names to null", () => {
    const result = validateSenatePortalExport(
      file([{ ...base, firstName: " ", lastName: "" }]),
    );
    expect(result.ok && result.rows[0].name).toBeNull();
  });

  it("drops a NUID column before any row is built, reporting only its name", () => {
    const result = validateSenatePortalExport(
      file([
        { ...base, nuid: NUID },
        { ...base, id: "p2", email: "b@northeastern.edu", NUID: NUID },
        { ...base, id: "p3", email: "c@northeastern.edu", role: "EBOARD" },
      ]),
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.droppedColumns).toEqual(["NUID", "nuid", "role"]);
    expect(JSON.stringify(result)).not.toContain(NUID);
    expect(JSON.stringify(result)).not.toContain("EBOARD");
  });

  it("rejects a missing column or a bad address, naming the path and never the value", () => {
    const noFirst: Record<string, unknown> = { ...base };
    delete noFirst.firstName;
    const result = validateSenatePortalExport(
      file([noFirst, { ...base, id: "p2", email: "not-an-address" }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.map((error) => error.path)).toEqual([
      "[0].firstName",
      "[1].email",
    ]);
    expect(JSON.stringify(result.errors)).not.toContain("not-an-address");
  });

  it("requires deletedAt to carry an offset", () => {
    const result = validateSenatePortalExport(
      file([{ ...base, deletedAt: "2025-01-01T00:00:00" }]),
    );
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate id, naming rows and never the value", () => {
    const result = validateSenatePortalExport(
      file([base, { ...base, email: "b@northeastern.edu" }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { path: "[1].id", message: "duplicate id (same as [0])" },
    ]);
  });

  it("reports unparseable bytes", () => {
    const result = validateSenatePortalExport("{");
    expect(result).toMatchObject({ ok: false, unparseable: true });
    expect(validateSenatePortalExport(file({ rows: [] }))).toMatchObject({
      ok: false,
      unparseable: false,
    });
  });
});

describe("planSenatePortalImport", () => {
  it("creates a verified, password-less, non-admin user", () => {
    const plan = planSenatePortalImport([row()], stateOf());
    expect(plan.rows[0]).toMatchObject({
      outcome: "create",
      userId: null,
      create: {
        email: "ada@northeastern.edu",
        name: "Ada Lovelace",
        emailVerified: true,
        legacyEmail: false,
        status: "ACTIVE",
        isAdmin: false,
      },
    });
  });

  it("defaults a missing name to the address's local part", () => {
    const plan = planSenatePortalImport([row({ name: null })], stateOf());
    expect(plan.rows[0].create?.name).toBe("ada");
    expect(plan.counts.nameDefaulted).toBe(1);
  });

  it("merges into a verified user, and notes a deactivated one", () => {
    const plan = planSenatePortalImport(
      [row(), row({ senatePortalId: "p2", email: "b@northeastern.edu" })],
      stateOf({
        "ada@northeastern.edu": verified(ID_A),
        "b@northeastern.edu": verified("id-b", "DEACTIVATED"),
      }),
    );
    expect(plan.rows.map((entry) => entry.outcome)).toEqual(["merge", "merge"]);
    expect(plan.rows[0].userId).toBe(ID_A);
    expect(plan.rows[1].notes).toEqual(["deactivated in SGAuth"]);
  });

  it("never maps onto an unverified or tombstoned account", () => {
    const plan = planSenatePortalImport(
      [row(), row({ senatePortalId: "p2", email: "b@northeastern.edu" })],
      stateOf({
        "ada@northeastern.edu": {
          id: ID_A,
          status: "ACTIVE",
          emailVerified: false,
        },
        "b@northeastern.edu": verified("id-b", "DELETED"),
      }),
    );
    expect(plan.rows.map((entry) => [entry.outcome, entry.reasons])).toEqual([
      ["skip", ["existing SGAuth account unverified; not mapped"]],
      ["skip", ["tombstoned in SGAuth"]],
    ]);
  });

  it("skips a soft-deleted row, and maps a repeated address to the first row's user", () => {
    const plan = planSenatePortalImport(
      [
        row({ senatePortalId: "gone", deletedAt: "2025-01-01T00:00:00Z" }),
        row(),
        row({ senatePortalId: "p2" }),
      ],
      stateOf({ "ada@northeastern.edu": verified(ID_A) }),
    );
    expect(plan.rows.map((entry) => entry.outcome)).toEqual([
      "skip",
      "merge",
      "duplicate-in-source",
    ]);
    expect(plan.rows[0].reasons).toEqual(["soft-deleted in SenatePortal"]);
    expect(plan.rows[2].userId).toBe(ID_A);
  });

  it("counts legacy addresses among created and merged rows only", () => {
    const plan = planSenatePortalImport(
      [
        row({ email: "old@gmail.com" }),
        row({
          senatePortalId: "p2",
          email: "gone@gmail.com",
          deletedAt: "2025-01-01T00:00:00Z",
        }),
      ],
      stateOf(),
    );
    expect(plan.rows[0].create?.legacyEmail).toBe(true);
    expect(plan.counts).toEqual({
      rows: 2,
      create: 1,
      merge: 0,
      duplicateInSource: 0,
      skip: 1,
      legacyEmails: 1,
      nameDefaulted: 0,
    });
  });
});

describe("module boundaries", () => {
  const source = (path: string) =>
    readFileSync(fileURLToPath(new URL(path, import.meta.url)), "utf8");

  it("imports nothing that can send mail or touch the database", () => {
    for (const path of [
      "./senateportal.ts",
      "../../../prisma/import/senateportal.ts",
      "../../../scripts/import-senateportal-users.ts",
    ]) {
      const imports = source(path).match(/from\s+"[^"]+"/g) ?? [];
      for (const spec of imports) {
        expect(spec).not.toMatch(
          /lib\/email\/|mailer|resend|email-otp|set-password|invite/i,
        );
      }
    }
    const pure = source("./senateportal.ts").match(/from\s+"[^"]+"/g) ?? [];
    for (const spec of pure) {
      expect(spec).not.toMatch(/prisma|server-only|node:fs/);
    }
  });
});
