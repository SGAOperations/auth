import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  BCRYPT_EXPORT_HASH,
  NEON_ADMIN_ROLES,
  SUPABASE_ADMIN_ROLES,
  formatReport,
  validateChambersExport,
  type ChambersExport,
} from "./chambers-export";

const SAMPLE_PATH = "docs/runbooks/chambers-export.sample.json";
const sampleText = readFileSync(SAMPLE_PATH, "utf8");

function sample(): ChambersExport {
  return JSON.parse(sampleText) as ChambersExport;
}

function run(
  mutate: (doc: Record<string, unknown> & ChambersExport) => void,
  opts?: Parameters<typeof validateChambersExport>[1],
) {
  const doc = sample() as Record<string, unknown> & ChambersExport;
  mutate(doc);
  return validateChambersExport(JSON.stringify(doc), opts);
}

const paths = (r: ReturnType<typeof run>) => r.errors.map((e) => e.path);
const BODY = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const TAIL = "abcdefghijklmnopqrstuuABCDEFGHIJKLMNOPQRSTUVWXYZ01234";

describe("the sample file", () => {
  it("validates and reports the documented counts", () => {
    const result = validateChambersExport(sampleText);
    expect(result.ok).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.counts).toMatchObject({
      users: 2,
      active: 1,
      inactive: 1,
      hashes: 1,
      nullHashes: 1,
      hashes2b: 1,
      memberships: 2,
      distinctBodies: 1,
      leadership: 1,
      member: 1,
      withIemsRole: 1,
    });
    expect(result.warnings).toHaveLength(2);
    expect(result.warnings[0]).toContain("no password hash");
    expect(result.warnings[1]).toContain("outside @northeastern.edu");
    expect(result.sha256).toMatch(/^[0-9a-f]{64}$/);
  });

  it("formats a report ending in VALID", () => {
    const report = formatReport(validateChambersExport(sampleText));
    expect(report).toContain("SHA-256:");
    expect(report.trimEnd().endsWith("VALID")).toBe(true);
  });
});

describe("envelope", () => {
  it.each([
    ["format", "other"],
    ["version", 2],
    ["source", "firebase"],
  ])("rejects a bad %s", (key, value) => {
    const result = run((d) => {
      d[key] = value;
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain(key);
  });

  it("rejects an unknown envelope key", () => {
    const result = run((d) => {
      d.extra = 1;
    });
    expect(result.ok).toBe(false);
  });

  it("rejects an unknown user key", () => {
    const result = run((d) => {
      (d.users[0] as Record<string, unknown>).otp_hash = "x";
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain("users[0]");
    expect(result.errors[0].id).toBe(sample().users[0].id);
  });

  it("accepts ids that are UUID-shaped but not RFC 4122 versioned", () => {
    const result = run((d) => {
      d.users[0].id = "00000000-0000-0000-0000-000000000001";
      d.users[0].board_memberships[0].body_id =
        "ffffffff-ffff-ffff-ffff-ffffffffffff";
    });
    expect(result.errors).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("rejects an id that is not UUID-shaped", () => {
    const result = run((d) => {
      d.users[0].id = "not-a-uuid";
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toContain("users[0].id");
  });

  it("reports unparseable bytes without an excerpt", () => {
    const result = validateChambersExport('{"format": "sgauth-chambers-ex');
    expect(result.unparseable).toBe(true);
    expect(result.errors).toEqual([{ path: "$", message: "not valid JSON" }]);
  });
});

describe("password_hash", () => {
  it.each([
    ["$2a$", "$2a$10$" + TAIL],
    ["$2b$", "$2b$12$" + TAIL],
  ])("accepts %s", (_name, hash) => {
    expect(BCRYPT_EXPORT_HASH.test(hash)).toBe(true);
    const result = run((d) => {
      d.users[0].password_hash = hash;
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["$2y$", "$2y$10$" + TAIL],
    ["59 characters", "$2b$10$" + TAIL.slice(1)],
    ["cost 03", "$2b$03$" + TAIL],
    ["scrypt", "scrypt:32768:8:1$salt$" + TAIL],
  ])("rejects %s and never echoes it", (_name, hash) => {
    const result = run((d) => {
      d.users[0].password_hash = hash;
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toEqual(["users[0].password_hash"]);
    expect(JSON.stringify(result.errors)).not.toContain(TAIL.slice(2, 30));
    expect(formatReport(result)).not.toContain(TAIL.slice(2, 30));
  });
});

describe("admin_role by source", () => {
  it("accepts Student Body President and rejects the dropped role on chambers-neon", () => {
    expect(NEON_ADMIN_ROLES).toContain("Student Body President");
    expect(
      run((d) => {
        d.users[0].admin_role = "Student Body President";
      }).ok,
    ).toBe(true);
    const bad = run((d) => {
      d.users[0].admin_role = "Digital Innovation Project Member";
    });
    expect(bad.ok).toBe(false);
    expect(paths(bad)).toEqual(["users[0].admin_role"]);
  });

  it("does the reverse on supabase", () => {
    expect(SUPABASE_ADMIN_ROLES).toContain("Digital Innovation Project Member");
    const ok = run((d) => {
      d.source = "supabase";
      d.users[0].admin_role = "Digital Innovation Project Member";
    });
    expect(ok.ok).toBe(true);
    expect(ok.warnings.some((w) => w.includes("fallback"))).toBe(true);
    const bad = run((d) => {
      d.source = "supabase";
      d.users[0].admin_role = "Student Body President";
    });
    expect(bad.ok).toBe(false);
    expect(paths(bad)).toEqual(["users[0].admin_role"]);
  });
});

describe("timestamps", () => {
  it("accepts +00:00 with microseconds and an infinite ban", () => {
    const result = run((d) => {
      d.users[0].created_at = "2025-09-01T12:00:00.123456+00:00";
      d.users[0].banned_until = "infinity";
    });
    expect(result.ok).toBe(true);
    expect(result.counts.banned).toBe(1);
  });

  it("counts a ban only while it is in force at exported_at", () => {
    const result = run((d) => {
      d.users[0].banned_until = "2026-12-01T00:00:00+00:00";
      d.users[1].banned_until = "2026-10-01T00:00:00+00:00";
    });
    expect(result.ok).toBe(true);
    expect(result.counts.banned).toBe(1);
  });

  it("rejects a datetime without an offset", () => {
    const result = run((d) => {
      d.users[0].created_at = "2025-09-01T12:00:00";
    });
    expect(paths(result)).toEqual(["users[0].created_at"]);
  });
});

describe("cross-row rules", () => {
  it("rejects a duplicate id", () => {
    const result = run((d) => {
      d.users[1].id = d.users[0].id;
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toEqual(["users[1].id"]);
  });

  it("rejects a case-only duplicate email without printing it", () => {
    const result = run((d) => {
      d.users[1].email = d.users[0].email.toUpperCase();
    });
    expect(result.ok).toBe(false);
    expect(paths(result)).toEqual(["users[1].email"]);
    const output = JSON.stringify(result.errors) + formatReport(result);
    expect(output.toLowerCase()).not.toContain("admin.sample");
    expect(result.errors[0].message).toContain("users[0]");
  });

  it("rejects a duplicate body within one user", () => {
    const result = run((d) => {
      d.users[0].board_memberships.push({ ...d.users[0].board_memberships[0] });
    });
    expect(paths(result)).toEqual(["users[0].board_memberships[1].body_id"]);
  });

  it("rejects a body_id with two names", () => {
    const result = run((d) => {
      d.users[1].board_memberships[0].body_name = "Renamed";
    });
    expect(paths(result)).toEqual(["users[1].board_memberships[0].body_name"]);
  });
});

describe("warnings", () => {
  it("flags emails that are not lower-case, and ones outside northeastern.edu", () => {
    const result = run((d) => {
      d.users[0].email = "Someone@Northeastern.edu";
    });
    expect(result.ok).toBe(true);
    expect(result.warnings.some((w) => w.includes("not lower-case"))).toBe(
      true,
    );
    expect(result.warnings.some((w) => w.includes("outside"))).toBe(true);
    expect(result.warnings.join("\n")).not.toContain("Someone");
  });
});

describe("expected counts", () => {
  it("passes when they match", () => {
    const result = validateChambersExport(sampleText, {
      expectUsers: 2,
      expectMemberships: 2,
      expectHashes: 1,
    });
    expect(result.ok).toBe(true);
  });

  it.each([
    ["expectUsers", "--expect-users", 3],
    ["expectMemberships", "--expect-memberships", 5],
    ["expectHashes", "--expect-hashes", 2],
  ] as const)("errors when %s differs", (key, flag, wrong) => {
    const result = validateChambersExport(sampleText, { [key]: wrong });
    expect(result.ok).toBe(false);
    expect(paths(result)).toEqual([flag]);
    expect(result.errors[0].message).toContain(`expected ${wrong}`);
  });
});

describe("checksum", () => {
  it("is stable for identical bytes and changes with one byte", () => {
    const a = validateChambersExport(sampleText).sha256;
    expect(validateChambersExport(Buffer.from(sampleText)).sha256).toBe(a);
    expect(validateChambersExport(sampleText + " ").sha256).not.toBe(a);
  });
});

describe("formatReport", () => {
  it("caps errors at 50 lines", () => {
    const result = run((d) => {
      d.users = Array.from({ length: 60 }, (_, i) => ({
        ...sample().users[0],
        id: `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
        email: "dup@northeastern.edu",
        board_memberships: [],
      }));
    });
    expect(result.errors.length).toBe(59);
    const report = formatReport(result);
    expect(report).toContain("...and 9 more");
    expect(report.trimEnd().endsWith("INVALID")).toBe(true);
    expect(report).not.toContain(BODY);
  });
});
