import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ warn: vi.fn() }));
vi.mock("@/lib/log", () => ({ logger: { warn: mocks.warn } }));

import { loadSecurityOverview } from "@/lib/account/security-overview";

interface UserRow {
  email: string;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  twoFactorEnabled: boolean;
  status: string;
}

const member: UserRow = {
  email: "a@husky.neu.edu",
  isAdmin: false,
  isPrimaryAdmin: false,
  twoFactorEnabled: false,
  status: "ACTIVE",
};

function stubDb(user: UserRow | null, backupCodes: string | null) {
  const findFirst = vi.fn(async () =>
    backupCodes === null ? null : { backupCodes },
  );
  const db = {
    user: { findUnique: vi.fn(async () => user) },
    twoFactor: { findFirst },
  };
  // The stub implements only the two reads the loader makes.
  return {
    db: db as unknown as Parameters<typeof loadSecurityOverview>[0],
    findFirst,
  };
}

beforeEach(() => mocks.warn.mockClear());

describe("loadSecurityOverview", () => {
  it("returns null when there is no user", async () => {
    const { db } = stubDb(null, null);
    expect(await loadSecurityOverview(db, "u1")).toBeNull();
  });

  it("describes a non-admin with two-factor off", async () => {
    const { db, findFirst } = stubDb(member, null);
    expect(await loadSecurityOverview(db, "u1")).toEqual({
      email: member.email,
      isAdmin: false,
      isPrimaryAdmin: false,
      twoFactorEnabled: false,
      canDisable: true,
      mfaRequired: false,
      backupCodesRemaining: null,
    });
    expect(findFirst).not.toHaveBeenCalled();
  });

  it("requires an admin without two-factor to enroll", async () => {
    const { db } = stubDb({ ...member, isAdmin: true }, null);
    const overview = await loadSecurityOverview(db, "u1");
    expect(overview).toMatchObject({
      mfaRequired: true,
      canDisable: false,
      backupCodesRemaining: null,
    });
  });

  it("counts the codes of an enrolled Primary Admin", async () => {
    const hashes = Array.from({ length: 7 }, (_, i) => `h1:${i}`);
    const { db } = stubDb(
      {
        ...member,
        isAdmin: true,
        isPrimaryAdmin: true,
        twoFactorEnabled: true,
      },
      JSON.stringify(hashes),
    );
    expect(await loadSecurityOverview(db, "u1")).toMatchObject({
      mfaRequired: false,
      canDisable: false,
      backupCodesRemaining: 7,
    });
  });

  it("reports an unknown count and warns when the list is malformed", async () => {
    const { db } = stubDb({ ...member, twoFactorEnabled: true }, "{not json");
    expect(await loadSecurityOverview(db, "u1")).toMatchObject({
      twoFactorEnabled: true,
      backupCodesRemaining: null,
    });
    expect(mocks.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(mocks.warn.mock.calls)).not.toContain("not json");
  });

  it("reports an unknown count for a list of the wrong shape", async () => {
    const { db } = stubDb({ ...member, twoFactorEnabled: true }, '{"a":1}');
    expect(
      (await loadSecurityOverview(db, "u1"))?.backupCodesRemaining,
    ).toBeNull();
    expect(mocks.warn).toHaveBeenCalledTimes(1);
  });

  it("reports an unknown count when the row is missing", async () => {
    const { db } = stubDb({ ...member, twoFactorEnabled: true }, null);
    expect(
      (await loadSecurityOverview(db, "u1"))?.backupCodesRemaining,
    ).toBeNull();
  });
});
