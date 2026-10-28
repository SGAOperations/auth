import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  NEON_ADMIN_ROLES,
  SUPABASE_ADMIN_ROLES,
  validateChambersExport,
  type ChambersExport,
  type ChambersExportUser,
} from "@/lib/import/chambers-export";
import { UsageError } from "../seed/sync-env";
import {
  ImportInputError,
  boardKey,
  buildIdMap,
  buildReport,
  checkApproval,
  formatImportSummary,
  isNortheasternEmail,
  loadEmailReplacements,
  loadMapping,
  loadSource,
  parseImportArgs,
  planImport,
  toImportRow,
  type ImportMapping,
  type ImportRow,
  type ImportState,
  type Replacements,
} from "./chambers";

const HASH = `$2b$10$${"a".repeat(53)}`;
const NOW = new Date("2026-11-02T16:00:00.000Z");
const BODY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const BODY_2 = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";

let dir: string;
let sample: ChambersExport;

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "chambers-import-"));
  sample = JSON.parse(
    await readFile(
      new URL(
        "../../docs/runbooks/chambers-export.sample.json",
        import.meta.url,
      ),
      "utf8",
    ),
  ) as ChambersExport;
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

let fileCounter = 0;
async function writeTemp(content: string | object): Promise<string> {
  fileCounter += 1;
  const path = join(dir, `file-${fileCounter}`);
  await writeFile(
    path,
    typeof content === "string" ? content : JSON.stringify(content),
  );
  return path;
}

let idCounter = 0;
function exportUser(
  overrides: Partial<ChambersExportUser> = {},
): ChambersExportUser {
  idCounter += 1;
  const n = String(idCounter).padStart(12, "0");
  return {
    id: `00000000-0000-4000-8000-${n}`,
    email: `user${idCounter}@northeastern.edu`,
    full_name: `User ${idCounter}`,
    password_hash: HASH,
    email_verified: true,
    email_confirmed_at: null,
    last_sign_in_at: null,
    banned_until: null,
    is_active: true,
    admin_role: null,
    iems_role: null,
    created_at: "2025-09-01T12:00:00+00:00",
    board_memberships: [],
    ...overrides,
  };
}

function replacements(entries: Record<string, string> = {}): Replacements {
  return new Map(
    Object.entries(entries).map(([old, email], index) => [
      old,
      { email, line: index + 1 },
    ]),
  );
}

function importRow(overrides: Partial<ImportRow> = {}): ImportRow {
  idCounter += 1;
  return {
    chambersId: `00000000-0000-4000-8000-${String(idCounter).padStart(12, "0")}`,
    sourceEmail: `row${idCounter}@northeastern.edu`,
    email: `row${idCounter}@northeastern.edu`,
    emailReplaced: false,
    name: `Row ${idCounter}`,
    bcryptHash: HASH,
    emailVerified: true,
    banned: false,
    active: true,
    roles: [],
    boardNames: new Map(),
    ...overrides,
  };
}

function mapping(
  roles: Record<string, string[]> = {},
  overrides: Partial<ImportMapping> = {},
): ImportMapping {
  return {
    approvedBy: null,
    approvedAt: null,
    roles: new Map(Object.entries(roles)),
    sha256: "m".repeat(64),
    ...overrides,
  };
}

function importState(overrides: Partial<ImportState> = {}): ImportState {
  return {
    users: new Map(),
    credentials: new Map(),
    holdings: new Map(),
    positions: new Map(),
    ...overrides,
  };
}

const POSITIONS = new Map([
  ["director", "p-director"],
  ["member", "p-member"],
  ["comptroller", "p-comptroller"],
]);

function plan(
  rows: ImportRow[],
  roles: Record<string, string[]> = {},
  state: Partial<ImportState> = {},
  reps: Replacements = new Map(),
  source: "chambers-neon" | "supabase" = "chambers-neon",
) {
  return planImport(
    rows,
    source,
    mapping(roles),
    reps,
    importState({ positions: POSITIONS, ...state }),
  );
}

describe("parseImportArgs", () => {
  const base = ["--source", "s.json", "--mapping", "m.json"];

  it("parses a dry run and an apply", () => {
    expect(parseImportArgs([...base, "--dry-run"], NOW)).toMatchObject({
      source: "s.json",
      mapping: "m.json",
      apply: false,
      emailReplacements: null,
    });
    expect(parseImportArgs([...base, "--apply"], NOW).apply).toBe(true);
  });

  it("rejects both modes and neither", () => {
    expect(() => parseImportArgs([...base, "--dry-run", "--apply"])).toThrow(
      UsageError,
    );
    expect(() => parseImportArgs(base)).toThrow(UsageError);
  });

  it("rejects a missing --source or --mapping", () => {
    expect(() => parseImportArgs(["--mapping", "m.json", "--apply"])).toThrow(
      /--source is required/,
    );
    expect(() => parseImportArgs(["--source", "s.json", "--apply"])).toThrow(
      /--mapping is required/,
    );
  });

  it("passes --email-replacements through when given", () => {
    const args = parseImportArgs(
      [...base, "--email-replacements", "r.txt", "--dry-run"],
      NOW,
    );
    expect(args.emailReplacements).toBe("r.txt");
  });

  it("rejects an unknown flag, a repeated flag and a flag with no value", () => {
    expect(() => parseImportArgs([...base, "--dry-run", "--force"])).toThrow(
      /Unknown argument/,
    );
    expect(() =>
      parseImportArgs([...base, "--source", "x", "--dry-run"]),
    ).toThrow(/more than once/);
    expect(() =>
      parseImportArgs(["--source", "--mapping", "m.json", "--dry-run"]),
    ).toThrow(/needs a value/);
  });

  it("defaults --out under .temp/chambers-import/ with a UTC timestamp", () => {
    expect(parseImportArgs([...base, "--dry-run"], NOW).out).toBe(
      ".temp/chambers-import/20261102-160000",
    );
    expect(
      parseImportArgs([...base, "--out", "somewhere", "--dry-run"], NOW).out,
    ).toBe("somewhere");
  });
});

describe("loadSource", () => {
  it("loads the sample, with the validator's checksum", async () => {
    const bytes = Buffer.from(JSON.stringify(sample));
    const loaded = await loadSource(await writeTemp(sample));
    expect(loaded.sha256).toBe(validateChambersExport(bytes).sha256);
    expect(loaded.data.users).toHaveLength(2);
    expect(Array.isArray(loaded.warnings)).toBe(true);
  });

  it("rejects an invalid export by path, without the hash or email", async () => {
    const bad = structuredClone(sample);
    bad.users[0].password_hash = `$2y$10$${"a".repeat(53)}`;
    const error = await loadSource(await writeTemp(bad)).catch(
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(ImportInputError);
    const message = (error as Error).message;
    expect(message).toContain("users[0].password_hash");
    expect(message).not.toContain("$2y$");
    expect(message).not.toContain("example.invalid");
  });

  it("rejects an unknown key and a duplicate email", async () => {
    const unknownKey = structuredClone(sample) as unknown as {
      users: Record<string, unknown>[];
    };
    unknownKey.users[0].extra = 1;
    await expect(loadSource(await writeTemp(unknownKey))).rejects.toThrow(
      ImportInputError,
    );

    const duplicate = structuredClone(sample);
    duplicate.users[1].email = duplicate.users[0].email.toUpperCase();
    const error = await loadSource(await writeTemp(duplicate)).catch(
      (e: unknown) => e,
    );
    expect((error as Error).message).toContain("duplicate email");
    expect((error as Error).message).not.toContain("example.invalid");
  });

  it("rejects invalid JSON", async () => {
    await expect(loadSource(await writeTemp("{nope"))).rejects.toThrow(
      "source is not valid JSON",
    );
  });
});

describe("loadMapping", () => {
  const goodUuid = "3f1c9a52-6e0b-4c1d-9a7e-2b8d4f6a0c11";

  it("accepts every Neon admin role and the Supabase-only role", async () => {
    const roles: Record<string, string[]> = {};
    for (const role of [...NEON_ADMIN_ROLES, ...SUPABASE_ADMIN_ROLES]) {
      roles[`admin_role:${role}`] = ["comptroller"];
    }
    const loaded = await loadMapping(await writeTemp({ roles }));
    expect(loaded.roles.get("admin_role:Student Body President")).toEqual([
      "comptroller",
    ]);
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("accepts both board roles for one body, with different positions", async () => {
    const loaded = await loadMapping(
      await writeTemp({
        $comment: "note",
        approvedBy: "pa@northeastern.edu",
        approvedAt: "2026-11-02",
        roles: {
          [boardKey(goodUuid, "Leadership")]: ["director-of-elections"],
          [boardKey(goodUuid, "Member")]: [],
          "iems_role:member": ["chambers-iems"],
        },
      }),
    );
    expect(loaded.roles.get(boardKey(goodUuid, "Leadership"))).toEqual([
      "director-of-elections",
    ]);
    expect(loaded.roles.get(boardKey(goodUuid, "Member"))).toEqual([]);
    expect(loaded.approvedBy).toBe("pa@northeastern.edu");
    expect(loaded.approvedAt).toBe("2026-11-02");
  });

  it.each([
    ["a bad key prefix", { "team:x": ["ab"] }, /must start with/],
    [
      "an admin_role in neither list",
      { "admin_role:Janitor": ["ab"] },
      /not a role the export validator allows/,
    ],
    [
      "a bare board key",
      { [`board:${goodUuid}`]: ["ab"] },
      /board:<body_id>:Leadership or board:<body_id>:Member/,
    ],
    [
      "an unknown board role",
      { [`board:${goodUuid}:Chair`]: ["ab"] },
      /board:<body_id>:Leadership or board:<body_id>:Member/,
    ],
    [
      "a wrong-case board role",
      { [`board:${goodUuid}:leadership`]: ["ab"] },
      /board:<body_id>:Leadership or board:<body_id>:Member/,
    ],
    [
      "a board key with a bad uuid",
      { "board:not-a-uuid:Member": ["ab"] },
      /not a uuid/,
    ],
    [
      "an empty iems role",
      { "iems_role:": ["ab"] },
      /iems_role value is empty/,
    ],
    [
      "a bad position key",
      { "iems_role:x": ["Bad Key"] },
      /roles\["iems_role:x"\]\[0\]/,
    ],
    ["a duplicate position key", { "iems_role:x": ["ab", "ab"] }, /duplicate/],
  ])("rejects %s", async (_label, roles, message) => {
    await expect(loadMapping(await writeTemp({ roles }))).rejects.toThrow(
      message,
    );
  });

  it("rejects a bad approvedAt and lists every problem", async () => {
    const error = await loadMapping(
      await writeTemp({ approvedAt: "11/02/2026", roles: {} }),
    ).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ImportInputError);
    expect((error as Error).message).toContain("approvedAt");

    const many = await loadMapping(
      await writeTemp({ roles: { "team:x": ["ab"], "iems_role:": ["ab"] } }),
    ).catch((e: unknown) => e);
    expect((many as Error).message).toContain("team:x");
    expect((many as Error).message).toContain("iems_role:");
  });

  it("rejects invalid JSON", async () => {
    await expect(loadMapping(await writeTemp("{"))).rejects.toThrow(
      "mapping is not valid JSON",
    );
  });
});

describe("isNortheasternEmail", () => {
  it.each(["a@northeastern.edu", "A@NorthEastern.EDU", " a@northeastern.edu "])(
    "accepts %s",
    (email) => expect(isNortheasternEmail(email)).toBe(true),
  );
  it.each([
    "a@coe.northeastern.edu",
    "a@northeastern.edu.evil.com",
    "a@gmail.com",
    "a@xnortheastern.edu",
  ])("rejects %s", (email) => expect(isNortheasternEmail(email)).toBe(false));
});

describe("loadEmailReplacements", () => {
  it("parses commas, whitespace, comments, blank lines and CRLF, lower-casing", async () => {
    const loaded = await loadEmailReplacements(
      await writeTemp(
        "# header\r\n\r\nOld.One@Example.com  new.one@northeastern.edu\r\n  # indented comment\r\nold.two@example.org,New.Two@Northeastern.edu\r\n",
      ),
    );
    expect(loaded.count).toBe(2);
    expect(loaded.replacements.get("old.one@example.com")).toEqual({
      email: "new.one@northeastern.edu",
      line: 3,
    });
    expect(loaded.replacements.get("old.two@example.org")).toEqual({
      email: "new.two@northeastern.edu",
      line: 5,
    });
    expect(loaded.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it.each([
    ["one field", "only@example.com"],
    ["three fields", "a@example.com b@northeastern.edu c@example.com"],
    ["an invalid old address", "not-an-email b@northeastern.edu"],
    ["an invalid new address", "a@example.com not-an-email"],
    ["a non-northeastern new address", "a@example.com b@example.org"],
    [
      "an already-northeastern old address",
      "a@northeastern.edu b@northeastern.edu",
    ],
    ["equal old and new", "a@northeastern.edu a@northeastern.edu"],
    [
      "a repeated old address",
      "a@example.com b@northeastern.edu\nA@example.com c@northeastern.edu",
    ],
    [
      "two old addresses to one new address",
      "a@example.com c@northeastern.edu\nb@example.com c@northeastern.edu",
    ],
  ])("rejects %s", async (_label, content) => {
    await expect(
      loadEmailReplacements(await writeTemp(content)),
    ).rejects.toThrow(ImportInputError);
  });

  it("lists every problem by line number and never echoes an address", async () => {
    const error = await loadEmailReplacements(
      await writeTemp(
        "secret.one@example.com\n\nsecret.two@example.com secret.two@example.org\n",
      ),
    ).catch((e: unknown) => e);
    const message = (error as Error).message;
    expect(message).toContain("line 1");
    expect(message).toContain("line 3");
    expect(message).not.toContain("secret");
  });
});

describe("toImportRow", () => {
  it("trims and lower-cases the email and keeps a northeastern one as is", () => {
    const row = toImportRow(
      exportUser({ email: "  Jane.Doe@Northeastern.EDU " }),
      replacements(),
      NOW,
    );
    expect(row).toMatchObject({
      sourceEmail: "jane.doe@northeastern.edu",
      email: "jane.doe@northeastern.edu",
      emailReplaced: false,
    });
  });

  it("uses a listed replacement and leaves an unlisted address null", () => {
    const reps = replacements({ "a@gmail.com": "a@northeastern.edu" });
    const replaced = toImportRow(
      exportUser({ email: "A@gmail.com", email_verified: true }),
      reps,
      NOW,
    );
    expect(replaced).toMatchObject({
      sourceEmail: "a@gmail.com",
      email: "a@northeastern.edu",
      emailReplaced: true,
      emailVerified: false,
    });
    const unlisted = toImportRow(
      exportUser({ email: "b@gmail.com" }),
      reps,
      NOW,
    );
    expect(unlisted).toMatchObject({ email: null, emailReplaced: false });
  });

  it("follows email_verified and ignores the Supabase-era fields", () => {
    expect(
      toImportRow(exportUser({ email_verified: true }), replacements(), NOW)
        .emailVerified,
    ).toBe(true);
    expect(
      toImportRow(
        exportUser({
          email_verified: false,
          email_confirmed_at: "2026-01-01T00:00:00+00:00",
        }),
        replacements(),
        NOW,
      ).emailVerified,
    ).toBe(false);
  });

  it("carries the name, the hash (including null) and is_active", () => {
    const row = toImportRow(
      exportUser({
        full_name: "Jane Doe",
        password_hash: null,
        is_active: false,
      }),
      replacements(),
      NOW,
    );
    expect(row).toMatchObject({
      name: "Jane Doe",
      bcryptHash: null,
      active: false,
    });
    expect(toImportRow(exportUser(), replacements(), NOW).bcryptHash).toBe(
      HASH,
    );
  });

  it.each([
    ["infinity", true],
    ["2026-12-01T00:00:00+00:00", true],
    ["2026-10-01T00:00:00+00:00", false],
    [null, false],
  ])("treats banned_until %s as banned=%s", (bannedUntil, banned) => {
    expect(
      toImportRow(
        exportUser({ banned_until: bannedUntil }),
        replacements(),
        NOW,
      ).banned,
    ).toBe(banned);
  });

  it("drops null roles and builds one key per membership with its own role", () => {
    const none = toImportRow(exportUser(), replacements(), NOW);
    expect(none.roles).toEqual([]);

    const row = toImportRow(
      exportUser({
        admin_role: "Comptroller",
        iems_role: "member",
        board_memberships: [
          { body_id: BODY, body_name: "Elections", role: "Leadership" },
          { body_id: BODY_2, body_name: "Academic", role: "Member" },
        ],
      }),
      replacements(),
      NOW,
    );
    expect(row.roles).toEqual([
      "admin_role:Comptroller",
      "iems_role:member",
      `board:${BODY}:Leadership`,
      `board:${BODY_2}:Member`,
    ]);
    expect(row.boardNames.get(BODY)).toBe("Elections");
  });
});

describe("planImport", () => {
  it("skips a banned row, even a non-northeastern one, as banned", () => {
    const result = plan([
      importRow({ banned: true }),
      importRow({ banned: true, email: null }),
    ]);
    expect(result.rows.map((r) => r.reasons)).toEqual([
      ["banned in Chambers"],
      ["banned in Chambers"],
    ]);
    expect(result.counts.nonNortheastern).toBe(0);
  });

  it("skips a non-northeastern row with no replacement and counts it", () => {
    const result = plan([importRow({ email: null })]);
    expect(result.rows[0]).toMatchObject({
      outcome: "skip",
      reasons: ["non-northeastern email; no replacement supplied"],
    });
    expect(result.counts.nonNortheastern).toBe(1);
  });

  it("skips every occurrence of a duplicate effective email", () => {
    const result = plan([
      importRow({ email: "same@northeastern.edu" }),
      importRow({
        email: "same@northeastern.edu",
        emailReplaced: true,
        emailVerified: false,
      }),
      importRow(),
    ]);
    expect(result.rows.map((r) => r.outcome)).toEqual([
      "skip",
      "skip",
      "create",
    ]);
    expect(result.rows[0].reasons).toEqual([
      "duplicate email after replacement",
    ]);
  });

  it("skips a tombstoned user", () => {
    const row = importRow();
    const result = plan(
      [row],
      {},
      {
        users: new Map([
          [row.email!, { id: "u1", status: "DELETED", emailVerified: true }],
        ]),
      },
    );
    expect(result.rows[0]).toMatchObject({
      outcome: "skip",
      reasons: ["tombstoned in SGAuth"],
    });
  });

  it("creates an active user with the union of mapped positions, once each", () => {
    const row = importRow({
      roles: ["admin_role:Comptroller", `board:${BODY}:Leadership`],
    });
    const result = plan([row], {
      "admin_role:Comptroller": ["comptroller", "director"],
      [`board:${BODY}:Leadership`]: ["director"],
    });
    expect(result.rows[0]).toMatchObject({
      outcome: "create",
      status: "ACTIVE",
      positionKeys: ["comptroller", "director"],
    });
    expect(result.counts.positionsAssigned).toBe(2);
  });

  it("gives Leadership and Member of one body their different positions", () => {
    const roles = {
      [`board:${BODY}:Leadership`]: ["director"],
      [`board:${BODY}:Member`]: ["member"],
    };
    const result = plan(
      [
        importRow({ roles: [`board:${BODY}:Leadership`] }),
        importRow({ roles: [`board:${BODY}:Member`] }),
      ],
      roles,
    );
    expect(result.rows.map((r) => r.positionKeys)).toEqual([
      ["director"],
      ["member"],
    ]);
  });

  it("creates a deactivated user with no positions and deactivatedAt later", () => {
    const result = plan(
      [importRow({ active: false, roles: ["admin_role:Comptroller"] })],
      { "admin_role:Comptroller": ["comptroller"] },
    );
    expect(result.rows[0]).toMatchObject({
      outcome: "create",
      status: "DEACTIVATED",
      positionKeys: [],
    });
    expect(result.rows[0].notes).toContain(
      "deactivated in Chambers; no positions assigned",
    );
  });

  it("creates under a replacement address, unverified, with account and positions", () => {
    const row = importRow({
      sourceEmail: "old@gmail.com",
      email: "new@northeastern.edu",
      emailReplaced: true,
      emailVerified: false,
      roles: ["admin_role:Comptroller"],
    });
    const result = plan([row], { "admin_role:Comptroller": ["comptroller"] });
    expect(result.rows[0]).toMatchObject({
      outcome: "create",
      positionKeys: ["comptroller"],
    });
    expect(result.rows[0].row.emailVerified).toBe(false);
    expect(result.rows[0].notes).toContain("email replaced");
    expect(result.counts.emailsReplaced).toBe(1);
  });

  it("creates a user with a null hash and says so", () => {
    const result = plan([importRow({ bcryptHash: null })]);
    expect(result.rows[0].outcome).toBe("create");
    expect(result.rows[0].notes).toContain(
      "no password in export (must reset)",
    );
  });

  describe("merge", () => {
    const existing = (
      overrides: Partial<{
        status: "ACTIVE" | "DEACTIVATED";
        emailVerified: boolean;
      }> = {},
    ) => ({
      id: "u1",
      status: "ACTIVE" as const,
      emailVerified: false,
      ...overrides,
    });
    const run = (
      row: ImportRow,
      state: Partial<ImportState> & { user?: ReturnType<typeof existing> },
      roles: Record<string, string[]> = {},
    ) => {
      const { user = existing(), ...rest } = state;
      return plan([row], roles, {
        users: new Map([[row.email!, user]]),
        ...rest,
      }).rows[0];
    };

    it("upgrades emailVerified but never downgrades it", () => {
      expect(run(importRow(), {}).setVerified).toBe(true);
      expect(
        run(importRow({ emailVerified: false }), {
          user: existing({ emailVerified: true }),
          credentials: new Map([["u1", { id: "a1", password: "x" }]]),
        }),
      ).toMatchObject({ outcome: "unchanged", setVerified: false });
    });

    it("adds a credential only when absent, and fills a null password", () => {
      expect(run(importRow(), {}).credential).toBe("create");
      expect(
        run(importRow(), {
          credentials: new Map([["u1", { id: "a1", password: null }]]),
        }),
      ).toMatchObject({ credential: "fill", credentialAccountId: "a1" });
    });

    it.each(["scrypt-hash-value", "bcrypt$already"])(
      "never touches an existing password (%s)",
      (password) => {
        expect(
          run(importRow({ emailVerified: false }), {
            credentials: new Map([["u1", { id: "a1", password }]]),
          }),
        ).toMatchObject({ outcome: "unchanged", credential: null });
      },
    );

    it("adds only the positions the user lacks and never removes any", () => {
      const result = run(
        importRow({ emailVerified: false, roles: ["admin_role:Comptroller"] }),
        {
          credentials: new Map([["u1", { id: "a1", password: "x" }]]),
          holdings: new Map([["u1", new Set(["p-comptroller", "p-other"])]]),
        },
        { "admin_role:Comptroller": ["comptroller", "director"] },
      );
      expect(result).toMatchObject({
        outcome: "merge",
        positionKeys: ["director"],
      });
    });

    it("adds no positions to a deactivated existing user and never changes status", () => {
      const result = run(
        importRow({
          emailVerified: false,
          bcryptHash: null,
          roles: ["admin_role:Comptroller"],
        }),
        { user: existing({ status: "DEACTIVATED" }) },
        { "admin_role:Comptroller": ["comptroller"] },
      );
      expect(result).toMatchObject({ outcome: "unchanged", positionKeys: [] });
      expect(result.notes).toContain(
        "already deactivated in SGAuth; no positions assigned",
      );
      expect(result.status).toBeNull();
    });

    it("merges a replaced row into an existing user without changing name or verification", () => {
      const row = importRow({
        sourceEmail: "old@gmail.com",
        emailReplaced: true,
        emailVerified: false,
        roles: ["admin_role:Comptroller"],
      });
      const result = run(
        row,
        {
          user: existing({ emailVerified: true }),
          credentials: new Map([["u1", { id: "a1", password: "x" }]]),
        },
        { "admin_role:Comptroller": ["comptroller"] },
      );
      expect(result).toMatchObject({
        outcome: "merge",
        userId: "u1",
        setVerified: false,
        positionKeys: ["comptroller"],
      });
    });

    it("is unchanged when there is nothing to add", () => {
      const result = run(importRow({ emailVerified: false }), {
        credentials: new Map([["u1", { id: "a1", password: "x" }]]),
      });
      expect(result.outcome).toBe("unchanged");
      expect(result.userId).toBe("u1");
    });
  });

  it("reports unmapped roles with body names, only the missing role of a body", () => {
    const rows = [
      importRow({
        roles: ["admin_role:Comptroller", `board:${BODY}:Leadership`],
        boardNames: new Map([[BODY, "Elections Board"]]),
      }),
      importRow({
        roles: [`board:${BODY}:Member`],
        boardNames: new Map([[BODY, "Elections Board"]]),
      }),
      importRow({
        roles: [`board:${BODY}:Member`, `board:${BODY_2}:Leadership`],
        boardNames: new Map([
          [BODY, "Elections Board"],
          [BODY_2, "Academic Services"],
        ]),
      }),
    ];
    const result = plan(rows, { [`board:${BODY}:Leadership`]: ["director"] });
    expect(result.unmappedRoles).toEqual([
      { key: "admin_role:Comptroller", rows: 1, bodyName: null },
      {
        key: `board:${BODY_2}:Leadership`,
        rows: 1,
        bodyName: "Academic Services",
      },
      { key: `board:${BODY}:Member`, rows: 2, bodyName: "Elections Board" },
    ]);
  });

  it("reports disallowed admin roles for the export's source", () => {
    const roles = {
      "admin_role:Digital Innovation Project Member": ["member"],
      "admin_role:Student Body President": ["director"],
    };
    expect(plan([], roles).disallowedAdminRoles).toEqual([
      "admin_role:Digital Innovation Project Member",
    ]);
    expect(
      plan([], roles, {}, new Map(), "supabase").disallowedAdminRoles,
    ).toEqual(["admin_role:Student Body President"]);
  });

  it("reports mapped position keys with no active position", () => {
    expect(
      plan([], { "iems_role:x": ["director", "ghost", "alsogone"] })
        .unknownKeys,
    ).toEqual(["alsogone", "ghost"]);
  });

  it("lists replacement lines that match no export row", () => {
    const reps: Replacements = new Map([
      ["used@gmail.com", { email: "used@northeastern.edu", line: 2 }],
      ["unused@gmail.com", { email: "unused@northeastern.edu", line: 5 }],
    ]);
    const result = plan(
      [importRow({ sourceEmail: "used@gmail.com" })],
      {},
      {},
      reps,
    );
    expect(result.unusedReplacements).toEqual([5]);
  });
});

describe("checkApproval", () => {
  const approved = mapping(
    {},
    { approvedBy: "PA@Northeastern.edu", approvedAt: "2026-11-02" },
  );

  it("throws in production with no approval or the wrong email", () => {
    expect(() =>
      checkApproval(mapping(), "pa@northeastern.edu", "production"),
    ).toThrow(ImportInputError);
    expect(() =>
      checkApproval(approved, "someone.else@northeastern.edu", "production"),
    ).toThrow(ImportInputError);
    expect(() =>
      checkApproval(
        mapping({}, { approvedBy: "pa@northeastern.edu", approvedAt: null }),
        "pa@northeastern.edu",
        "production",
      ),
    ).toThrow(ImportInputError);
    expect(() => checkApproval(approved, null, "production")).toThrow(
      ImportInputError,
    );
  });

  it("passes in production for the Primary Admin, ignoring case", () => {
    expect(
      checkApproval(approved, "pa@northeastern.edu", "production"),
    ).toBeNull();
  });

  it("only warns outside production", () => {
    expect(checkApproval(mapping(), "pa@northeastern.edu", "dev")).toMatch(
      /not approved/,
    );
    expect(checkApproval(approved, "pa@northeastern.edu", "dev")).toBeNull();
  });
});

describe("report, id map and summary", () => {
  const META = {
    generatedAt: NOW,
    dryRun: true,
    target: "host/db",
    exportedAt: "2026-11-02T15:00:00+00:00",
    sourceSha256: "s".repeat(64),
    mappingSha256: "m".repeat(64),
    replacementsSha256: null,
  };

  function samplePlan() {
    const created = importRow({ roles: ["admin_role:Comptroller"] });
    const replaced = importRow({
      sourceEmail: "old@gmail.com",
      email: "new@northeastern.edu",
      emailReplaced: true,
      emailVerified: false,
    });
    const skippedRow = importRow({ email: null, sourceEmail: "x@gmail.com" });
    const banned = importRow({ banned: true });
    const result = plan([created, replaced, skippedRow, banned], {
      "admin_role:Comptroller": ["comptroller"],
    });
    return {
      ...result,
      rows: result.rows.map((entry, index) =>
        entry.outcome === "skip" ? entry : { ...entry, userId: `sg-${index}` },
      ),
    };
  }

  it("never serialises a hash", () => {
    const result = samplePlan();
    const json =
      JSON.stringify(buildReport(result, META)) +
      JSON.stringify(buildIdMap(result, META));
    expect(json).not.toContain("$2");
    expect(json).not.toContain("bcrypt$");
    expect(json).not.toContain(HASH);
  });

  it("carries the replaced row's addresses and the export details", () => {
    const report = buildReport(samplePlan(), META);
    expect(report).toMatchObject({
      exportSource: "chambers-neon",
      exportedAt: META.exportedAt,
      dryRun: true,
    });
    expect(report.rows[1]).toMatchObject({
      sourceEmail: "old@gmail.com",
      email: "new@northeastern.edu",
      emailReplaced: true,
      outcome: "create",
    });
    expect(report.rows[2]).toMatchObject({ email: null, outcome: "skip" });
  });

  it("leaves skipped rows out of the id map and shows the new address", () => {
    const map = buildIdMap(samplePlan(), META);
    expect(map.mappings).toHaveLength(2);
    expect(map.mappings[1]).toMatchObject({
      sgauthId: "sg-1",
      email: "new@northeastern.edu",
      emailReplaced: true,
    });
  });

  it("formats skips, notes and counts without emails", () => {
    const result = samplePlan();
    const text = formatImportSummary({
      ...result,
      unusedReplacements: [4],
    });
    const lines = text.split("\n");
    expect(lines).toContain(
      `! skip ${result.rows[2].row.chambersId} non-northeastern email; no replacement supplied`,
    );
    expect(lines).toContain(
      `! skip ${result.rows[3].row.chambersId} banned in Chambers`,
    );
    expect(lines).toContain(
      "! 1 non-northeastern rows have no replacement; see report.json",
    );
    expect(lines).toContain("? replacement line 4 matches no export row");
    expect(lines.at(-1)).toBe(
      "4 rows: 2 create, 0 merge, 0 unchanged, 2 skip (1 non-northeastern); 1 emails replaced; 1 position assignments",
    );
    expect(text).not.toContain("@");
  });

  it("renders unmapped keys, a body's Leadership before its Member", () => {
    const rows = [
      importRow({
        roles: [`board:${BODY}:Member`, `board:${BODY}:Leadership`],
        boardNames: new Map([[BODY, "Elections Board"]]),
      }),
    ];
    const text = formatImportSummary(
      plan(rows, {}, {}, new Map(), "chambers-neon"),
    );
    const lines = text.split("\n");
    expect(lines[0]).toBe(
      `? unmapped role board:${BODY}:Leadership "Elections Board" (1 row)`,
    );
    expect(lines[1]).toBe(
      `? unmapped role board:${BODY}:Member "Elections Board" (1 row)`,
    );
  });

  it("renders disallowed roles and unknown keys", () => {
    const text = formatImportSummary(
      plan([], {
        "admin_role:Digital Innovation Project Member": ["ghost"],
      }),
    );
    expect(text).toContain(
      "? admin_role:Digital Innovation Project Member is not a chambers-neon role",
    );
    expect(text).toContain("? unknown position key ghost");
  });
});
