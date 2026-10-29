import { describe, expect, it } from "vitest";
import type { AplioExisting, AplioRow } from "@/lib/import/aplio";
import {
  reconcileAplio,
  type DualWriteUser,
} from "@/lib/import/aplio-reconcile";

const ID_A = "0192f1a0-0000-7000-8000-000000000001";
const ID_B = "0192f1a0-0000-7000-8000-000000000002";
const CUTOVER = new Date("2026-12-01T05:00:00Z");
const BEFORE = new Date("2026-11-30T05:00:00Z");

function row(overrides: Partial<AplioRow> = {}): AplioRow {
  return {
    aplioId: "a1",
    email: "ada@northeastern.edu",
    name: "Ada",
    isAdmin: false,
    deletedAt: null,
    sgauthUserId: ID_A,
    ...overrides,
  };
}

const user = (
  id: string,
  patch: Partial<AplioExisting> = {},
): AplioExisting => ({
  id,
  status: "ACTIVE",
  emailVerified: true,
  ...patch,
});

function run(
  rows: AplioRow[],
  users: Record<string, AplioExisting> = {},
  dualWrite: DualWriteUser[] = [],
  now = BEFORE,
) {
  return reconcileAplio(
    rows,
    { users: new Map(Object.entries(users)) },
    dualWrite,
    now,
    CUTOVER,
  );
}

describe("reconcileAplio", () => {
  it("is ok when the user exists and the stored id matches", () => {
    const result = run([row()], { "ada@northeastern.edu": user(ID_A) });
    expect(result.entries[0].category).toBe("ok");
    expect(result.ready).toBe(true);
    expect(result.reasons).toEqual([]);
  });

  it("reports missing-in-sgauth when no user has the address", () => {
    const result = run([row()]);
    expect(result.entries[0].category).toBe("missing-in-sgauth");
    expect(result.ready).toBe(false);
    expect(result.reasons).toEqual(["1 missing-in-sgauth"]);
  });

  it("reports needs-backfill when Aplio stored no id", () => {
    const result = run([row({ sgauthUserId: null })], {
      "ada@northeastern.edu": user(ID_A),
    });
    expect(result.entries[0].category).toBe("needs-backfill");
    expect(result.ready).toBe(false);
  });

  it("reports mismatch when the stored id names another user", () => {
    const result = run([row({ sgauthUserId: ID_B })], {
      "ada@northeastern.edu": user(ID_A),
    });
    expect(result.entries[0].category).toBe("mismatch");
    expect(result.ready).toBe(false);
  });

  it.each([
    ["unverified", { emailVerified: false }],
    ["tombstoned", { status: "DELETED" as const }],
  ])("reports blocked for an %s account", (_label, patch) => {
    const result = run([row()], {
      "ada@northeastern.edu": user(ID_A, patch),
    });
    expect(result.entries[0].category).toBe("blocked");
    expect(result.ready).toBe(false);
  });

  it("treats a deactivated verified account as ok", () => {
    const result = run([row()], {
      "ada@northeastern.edu": user(ID_A, { status: "DEACTIVATED" }),
    });
    expect(result.entries[0].category).toBe("ok");
  });

  it("ignores soft-deleted rows", () => {
    const result = run([row({ deletedAt: "2026-01-01T00:00:00Z" })]);
    expect(result.entries).toEqual([]);
    expect(result.ready).toBe(true);
  });

  it("counts every category and lists every reason", () => {
    const result = run(
      [
        row({ aplioId: "ok" }),
        row({ aplioId: "gone", email: "gone@northeastern.edu" }),
        row({
          aplioId: "nb",
          email: "nb@northeastern.edu",
          sgauthUserId: null,
        }),
        row({
          aplioId: "mm",
          email: "mm@northeastern.edu",
          sgauthUserId: ID_B,
        }),
      ],
      {
        "ada@northeastern.edu": user(ID_A),
        "nb@northeastern.edu": user(ID_B),
        "mm@northeastern.edu": user(ID_A),
      },
    );
    expect(result.counts).toEqual({
      ok: 1,
      "missing-in-sgauth": 1,
      "needs-backfill": 1,
      mismatch: 1,
      blocked: 0,
    });
    expect(result.reasons).toEqual([
      "1 missing-in-sgauth",
      "1 needs-backfill",
      "1 mismatch",
    ]);
  });

  it("is not ready at the cutover instant, and never after it", () => {
    const users = { "ada@northeastern.edu": user(ID_A) };
    expect(run([row()], users, [], CUTOVER).ready).toBe(false);
    expect(run([row()], users, [], CUTOVER).reasons).toEqual([
      "cutover has passed",
    ]);
    expect(run([row()], users, [], new Date(CUTOVER.getTime() + 1)).ready).toBe(
      false,
    );
    expect(run([row()], users, [], new Date(CUTOVER.getTime() - 1)).ready).toBe(
      true,
    );
  });

  it("lists sgauth-only users without blocking", () => {
    const result = run([row()], { "ada@northeastern.edu": user(ID_A) }, [
      { userId: ID_A, email: "Ada@northeastern.edu" },
      { userId: ID_B, email: "stray@northeastern.edu" },
    ]);
    expect(result.sgauthOnly).toEqual([
      { userId: ID_B, email: "stray@northeastern.edu" },
    ]);
    expect(result.ready).toBe(true);
  });

  it("counts a dual-written user matching only a soft-deleted row as sgauth-only", () => {
    const result = run(
      [row({ deletedAt: "2026-01-01T00:00:00Z" })],
      { "ada@northeastern.edu": user(ID_A) },
      [{ userId: ID_A, email: "ada@northeastern.edu" }],
    );
    expect(result.sgauthOnly).toHaveLength(1);
    expect(result.ready).toBe(true);
  });
});
