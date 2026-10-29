import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { listUpcomingTombstones } from "@/lib/retention/upcoming";
import { createAdmin, createUser } from "@/test/factories";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date();
const at = (days: number) => new Date(NOW.getTime() + days * DAY_MS);

// Other cases share the table, so each one looks only at its own users.
async function listed(withinDays: number, ids: string[]) {
  const rows = await listUpcomingTombstones(prisma, {
    now: NOW,
    withinDays,
  });
  return rows.filter((row) => ids.includes(row.userId));
}

describe("listUpcomingTombstones", () => {
  it("projects each rule's date, soonest first, with admins flagged", async () => {
    const deactivated = await createUser({
      status: "DEACTIVATED",
      deactivatedAt: at(-25),
    });
    // 340 days idle and never noticed: the notice goes out on the next run, and
    // its 30 days run from then.
    const unnoticed = await createUser({ lastLoginAt: at(-340) });
    // 360 days idle, noticed 10 days ago.
    const noticed = await createUser({
      lastLoginAt: at(-360),
      inactivityNoticeSentAt: at(-10),
    });
    const admin = await createAdmin({ lastLoginAt: at(-400) });
    const fresh = await createUser({ lastLoginAt: at(-5) });
    const ids = [deactivated, unnoticed, noticed, admin, fresh].map(
      (u) => u.id,
    );

    const rows = await listed(30, ids);

    // The admin and the unnoticed user share a date, so only the first two
    // places are fixed.
    expect(rows.slice(0, 2).map((row) => row.userId)).toEqual([
      deactivated.id,
      noticed.id,
    ]);
    expect(rows.map((row) => row.userId).sort()).toEqual(
      [deactivated.id, noticed.id, admin.id, unnoticed.id].sort(),
    );
    const byId = Object.fromEntries(rows.map((row) => [row.userId, row]));
    expect(byId[deactivated.id]).toMatchObject({
      status: "DEACTIVATED",
      rule: "deactivated",
      tombstoneAt: at(5),
      noticeSentAt: null,
      exempt: false,
    });
    expect(byId[unnoticed.id]).toMatchObject({
      status: "ACTIVE",
      rule: "inactive",
      tombstoneAt: at(30),
      noticeSentAt: null,
      exempt: false,
    });
    expect(byId[noticed.id]).toMatchObject({
      rule: "inactive",
      tombstoneAt: at(20),
      noticeSentAt: at(-10),
    });
    expect(byId[admin.id]).toMatchObject({ exempt: true });
  });

  it("narrows to the window", async () => {
    const deactivated = await createUser({
      status: "DEACTIVATED",
      deactivatedAt: at(-25),
    });
    expect(await listed(4, [deactivated.id])).toEqual([]);
    expect(await listed(5, [deactivated.id])).toHaveLength(1);
  });

  it("ignores a notice that a later sign-in superseded", async () => {
    const user = await createUser({
      lastLoginAt: at(-20),
      inactivityNoticeSentAt: at(-100),
    });
    expect(await listed(90, [user.id])).toEqual([]);
  });

  it("leaves out a recent unverified sign-up and deleted users", async () => {
    const unverified = await createUser({
      emailVerified: false,
      createdAt: at(-10),
    });
    const deleted = await createUser({
      status: "DELETED",
      lastLoginAt: at(-500),
    });
    expect(await listed(90, [unverified.id, deleted.id])).toEqual([]);
  });
});
