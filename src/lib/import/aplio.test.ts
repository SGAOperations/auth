import { describe, expect, it } from "vitest";
import {
  planAplioImport,
  planAplioRow,
  validateAplioExport,
  type AplioExisting,
  type AplioRow,
  type AplioState,
} from "@/lib/import/aplio";

const ID_A = "0192f1a0-0000-7000-8000-000000000001";
const ID_B = "0192f1a0-0000-7000-8000-000000000002";

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

function stateOf(users: Record<string, AplioExisting> = {}): AplioState {
  return { users: new Map(Object.entries(users)) };
}

const verified = (id: string, status: AplioExisting["status"] = "ACTIVE") => ({
  id,
  status,
  emailVerified: true,
});

describe("validateAplioExport", () => {
  const file = (rows: unknown) => JSON.stringify(rows);
  const base = {
    id: "a1",
    email: "Ada@Northeastern.edu ",
    name: "Ada",
    isAdmin: false,
    deletedAt: null,
  };

  it("parses rows, normalising the address and hashing the bytes", () => {
    const result = validateAplioExport(file([base]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.rows[0]).toMatchObject({
      aplioId: "a1",
      email: "ada@northeastern.edu",
      sgauthUserId: null,
    });
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts sgauthUserId as a uuid or null", () => {
    const result = validateAplioExport(
      file([
        { ...base, sgauthUserId: ID_A },
        { ...base, id: "a2", email: "b@northeastern.edu", sgauthUserId: null },
      ]),
    );
    expect(result.ok).toBe(true);
  });

  it("rejects an unknown column", () => {
    const result = validateAplioExport(file([{ ...base, password: "x" }]));
    expect(result.ok).toBe(false);
  });

  it("rejects a duplicate id, naming rows and never the value", () => {
    const result = validateAplioExport(
      file([base, { ...base, email: "b@northeastern.edu" }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors).toEqual([
      { path: "[1].id", message: "duplicate id (same as [0])" },
    ]);
  });

  it("does not reject a duplicate address", () => {
    const result = validateAplioExport(
      file([base, { ...base, id: "a2", email: "ADA@northeastern.edu" }]),
    );
    expect(result.ok).toBe(true);
  });

  it("reports paths and rules without echoing a bad value", () => {
    const result = validateAplioExport(
      file([{ ...base, email: "not-an-email-secret" }]),
    );
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors[0].path).toBe("[0].email");
    expect(JSON.stringify(result.errors)).not.toContain("not-an-email-secret");
  });

  it.each([
    ["a missing offset on deletedAt", { deletedAt: "2025-01-01T00:00:00" }],
    ["a non-boolean isAdmin", { isAdmin: "yes" }],
    ["an empty id", { id: "" }],
    ["a non-uuid sgauthUserId", { sgauthUserId: "42" }],
  ])("rejects %s", (_label, patch) => {
    expect(validateAplioExport(file([{ ...base, ...patch }])).ok).toBe(false);
  });

  it("flags bytes that are not JSON", () => {
    const result = validateAplioExport("{nope");
    expect(result).toMatchObject({ ok: false, unparseable: true });
  });

  it("rejects a top level that is not an array", () => {
    expect(validateAplioExport(file({ users: [] })).ok).toBe(false);
  });
});

describe("planAplioRow", () => {
  it("creates a verified, password-less, non-admin account", () => {
    const decision = planAplioRow(
      { email: "ada@northeastern.edu", name: " Ada " },
      undefined,
    );
    expect(decision).toEqual({
      outcome: "create",
      create: {
        email: "ada@northeastern.edu",
        name: "Ada",
        emailVerified: true,
        legacyEmail: false,
        status: "ACTIVE",
        isAdmin: false,
      },
      notes: [],
    });
  });

  it("flags a non-northeastern address as legacy", () => {
    const decision = planAplioRow({ email: "ada@gmail.com", name: "Ada" });
    expect(decision).toMatchObject({
      outcome: "create",
      create: { legacyEmail: true },
    });
  });

  it("counts a subdomain of northeastern.edu as legacy", () => {
    const decision = planAplioRow({
      email: "ada@husky.northeastern.edu",
      name: "Ada",
    });
    expect(decision).toMatchObject({
      outcome: "create",
      create: { legacyEmail: true },
    });
  });

  it.each([null, "", "   "])(
    "defaults the name %j to the local part",
    (name) => {
      expect(
        planAplioRow({ email: "ada.l@northeastern.edu", name }, undefined),
      ).toMatchObject({
        create: { name: "ada.l" },
        notes: ["name defaulted"],
      });
    },
  );

  it("merges into a verified account and writes nothing", () => {
    expect(
      planAplioRow(
        { email: "ada@northeastern.edu", name: "Other" },
        verified(ID_A),
      ),
    ).toEqual({ outcome: "merge", userId: ID_A, notes: [] });
  });

  it("notes a deactivated account it merges into", () => {
    expect(
      planAplioRow(
        { email: "ada@northeastern.edu", name: null },
        verified(ID_A, "DEACTIVATED"),
      ),
    ).toEqual({
      outcome: "merge",
      userId: ID_A,
      notes: ["deactivated in SGAuth"],
    });
  });

  it("skips a tombstoned account", () => {
    expect(
      planAplioRow(
        { email: "ada@northeastern.edu", name: null },
        verified(ID_A, "DELETED"),
      ),
    ).toMatchObject({ outcome: "skip", reason: "tombstoned in SGAuth" });
  });

  it("skips an unverified account rather than mapping to it", () => {
    expect(
      planAplioRow(
        { email: "ada@northeastern.edu", name: null },
        { id: ID_A, status: "ACTIVE", emailVerified: false },
      ),
    ).toMatchObject({
      outcome: "skip",
      reason: "existing SGAuth account unverified; not mapped",
    });
  });
});

describe("planAplioImport", () => {
  it("skips a soft-deleted row and leaves it out of the mapping", () => {
    const plan = planAplioImport(
      [row({ deletedAt: "2025-01-01T00:00:00Z" })],
      stateOf(),
    );
    expect(plan.rows[0]).toMatchObject({
      outcome: "skip",
      reasons: ["soft-deleted in Aplio"],
      userId: null,
    });
    expect(plan.counts.skip).toBe(1);
  });

  it("merges a case-insensitive duplicate of a verified user", () => {
    const plan = planAplioImport(
      [row({ email: "ada@northeastern.edu" })],
      stateOf({ "ada@northeastern.edu": verified(ID_A) }),
    );
    expect(plan.rows[0]).toMatchObject({ outcome: "merge", userId: ID_A });
    expect(plan.rows[0].create).toBeNull();
    expect(plan.counts).toMatchObject({ create: 0, merge: 1 });
  });

  it("skips and does not map an unverified existing user", () => {
    const plan = planAplioImport(
      [row()],
      stateOf({
        "ada@northeastern.edu": {
          id: ID_A,
          status: "ACTIVE",
          emailVerified: false,
        },
      }),
    );
    expect(plan.rows[0]).toMatchObject({
      outcome: "skip",
      userId: null,
      reasons: ["existing SGAuth account unverified; not mapped"],
    });
  });

  it("skips a tombstoned existing user", () => {
    const plan = planAplioImport(
      [row()],
      stateOf({ "ada@northeastern.edu": verified(ID_A, "DELETED") }),
    );
    expect(plan.rows[0]).toMatchObject({
      outcome: "skip",
      reasons: ["tombstoned in SGAuth"],
    });
  });

  it("creates a non-admin for isAdmin: true and counts it", () => {
    const plan = planAplioImport([row({ isAdmin: true })], stateOf());
    expect(plan.rows[0].create).toMatchObject({ isAdmin: false });
    expect(plan.counts.aplioAdmins).toBe(1);
  });

  it("does not count a soft-deleted admin", () => {
    const plan = planAplioImport(
      [row({ isAdmin: true, deletedAt: "2025-01-01T00:00:00Z" })],
      stateOf(),
    );
    expect(plan.counts.aplioAdmins).toBe(0);
  });

  it("creates a non-northeastern user as legacy and lists it", () => {
    const plan = planAplioImport([row({ email: "ada@gmail.com" })], stateOf());
    expect(plan.rows[0].create).toMatchObject({ legacyEmail: true });
    expect(plan.counts.legacyEmails).toBe(1);
  });

  it("counts a non-northeastern merge as a legacy email too", () => {
    const plan = planAplioImport(
      [row({ email: "ada@gmail.com" })],
      stateOf({ "ada@gmail.com": verified(ID_A) }),
    );
    expect(plan.rows[0].outcome).toBe("merge");
    expect(plan.counts.legacyEmails).toBe(1);
  });

  it("does not list a northeastern user, or a skipped legacy one", () => {
    const plan = planAplioImport(
      [
        row(),
        row({
          aplioId: "a2",
          email: "gone@gmail.com",
          deletedAt: "2025-01-01T00:00:00Z",
        }),
      ],
      stateOf(),
    );
    expect(plan.counts.legacyEmails).toBe(0);
  });

  it("maps an in-file duplicate to the same user as the first row", () => {
    const plan = planAplioImport(
      [row(), row({ aplioId: "a2", name: "Ada Two" })],
      stateOf({ "ada@northeastern.edu": verified(ID_A) }),
    );
    expect(plan.rows.map((entry) => entry.outcome)).toEqual([
      "merge",
      "duplicate-in-source",
    ]);
    expect(plan.rows[1].userId).toBe(ID_A);
    expect(plan.counts).toMatchObject({ merge: 1, duplicateInSource: 1 });
  });

  it("makes one create for in-file duplicates of a new address", () => {
    const plan = planAplioImport([row(), row({ aplioId: "a2" })], stateOf());
    expect(plan.counts).toMatchObject({ create: 1, duplicateInSource: 1 });
  });

  it("lets a live row follow a soft-deleted row at the same address", () => {
    const plan = planAplioImport(
      [row({ deletedAt: "2025-01-01T00:00:00Z" }), row({ aplioId: "a2" })],
      stateOf(),
    );
    expect(plan.rows.map((entry) => entry.outcome)).toEqual(["skip", "create"]);
  });

  it("skips a later duplicate when the first was skipped", () => {
    const plan = planAplioImport(
      [row(), row({ aplioId: "a2" })],
      stateOf({ "ada@northeastern.edu": verified(ID_B, "DELETED") }),
    );
    expect(plan.rows.map((entry) => entry.outcome)).toEqual(["skip", "skip"]);
    expect(plan.rows[1].reasons).toEqual(["tombstoned in SGAuth"]);
  });

  it("counts a defaulted name once", () => {
    const plan = planAplioImport([row({ name: null })], stateOf());
    expect(plan.rows[0].notes).toEqual(["name defaulted"]);
    expect(plan.counts.nameDefaulted).toBe(1);
  });

  it("ignores sgauthUserId: the mapping comes from the address", () => {
    const plan = planAplioImport(
      [row({ sgauthUserId: ID_B })],
      stateOf({ "ada@northeastern.edu": verified(ID_A) }),
    );
    expect(plan.rows[0].userId).toBe(ID_A);
  });
});
