import { describe, expect, it } from "vitest";
import { loadPositionHolders } from "@/lib/position-holders";
import { prisma } from "@/lib/prisma";
import { createPosition, createUser } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 10);
let seq = 0;
const key = (label: string) => `${label}-${rand}-${(seq += 1)}`;

const hold = (userId: string, positionId: string, assignedAt?: Date) =>
  prisma.userPosition.create({ data: { userId, positionId, assignedAt } });

describe("loadPositionHolders", () => {
  it("returns an active holder with the session user fields", async () => {
    const k = key("comptroller");
    const position = await createPosition({ key: k, name: "Comptroller" });
    const user = await createUser({
      name: "Sam Example",
      preferredName: "Sam",
    });
    await hold(user.id, position.id);

    const result = await loadPositionHolders(prisma, [k]);

    expect(result).toEqual({
      positions: [
        {
          key: k,
          name: "Comptroller",
          holders: [
            {
              id: user.id,
              email: user.email,
              name: "Sam Example",
              preferredName: "Sam",
            },
          ],
        },
      ],
      unknownKeys: [],
    });
  });

  it("leaves out a deactivated holder and a deleted user", async () => {
    const k = key("treasurer");
    const position = await createPosition({ key: k });
    const active = await createUser();
    const deactivated = await createUser({ status: "DEACTIVATED" });
    const deleted = await createUser({ status: "DELETED" });
    await hold(active.id, position.id);
    await hold(deactivated.id, position.id);
    await hold(deleted.id, position.id);

    const result = await loadPositionHolders(prisma, [k]);

    expect(result.positions[0]?.holders.map((h) => h.id)).toEqual([active.id]);
  });

  it("answers a vacant position with no holders, not as unknown", async () => {
    const k = key("vacant");
    await createPosition({ key: k });

    const result = await loadPositionHolders(prisma, [k]);

    expect(result.positions).toMatchObject([{ key: k, holders: [] }]);
    expect(result.unknownKeys).toEqual([]);
  });

  it("puts an unknown key and a deleted position's key in unknownKeys", async () => {
    const deletedKey = key("gone");
    await createPosition({ key: deletedKey, deletedAt: new Date() });
    const missing = key("missing");

    const result = await loadPositionHolders(prisma, [deletedKey, missing]);

    expect(result).toEqual({
      positions: [],
      unknownKeys: [deletedKey, missing],
    });
  });

  it("returns only the new position for a retired and reused key", async () => {
    const k = key("reused");
    const old = await createPosition({
      key: k,
      name: "Old",
      deletedAt: new Date(),
    });
    const fresh = await createPosition({ key: k, name: "New" });
    const oldHolder = await createUser();
    const newHolder = await createUser();
    await hold(oldHolder.id, old.id);
    await hold(newHolder.id, fresh.id);

    const result = await loadPositionHolders(prisma, [k]);

    expect(result.positions).toHaveLength(1);
    expect(result.positions[0]).toMatchObject({ key: k, name: "New" });
    expect(result.positions[0]?.holders.map((h) => h.id)).toEqual([
      newHolder.id,
    ]);
  });

  it("follows request order and sorts holders by assignment time", async () => {
    const first = key("first");
    const second = key("second");
    const a = await createPosition({ key: first });
    const b = await createPosition({ key: second });
    const early = await createUser();
    const late = await createUser();
    await hold(late.id, a.id, new Date("2026-02-01T00:00:00Z"));
    await hold(early.id, a.id, new Date("2026-01-01T00:00:00Z"));
    await hold(early.id, b.id);

    const result = await loadPositionHolders(prisma, [second, first]);

    expect(result.positions.map((p) => p.key)).toEqual([second, first]);
    expect(result.positions[1]?.holders.map((h) => h.id)).toEqual([
      early.id,
      late.id,
    ]);
  });

  it("collapses duplicate keys", async () => {
    const k = key("dup");
    await createPosition({ key: k });

    const result = await loadPositionHolders(prisma, [k, k, k]);

    expect(result.positions).toHaveLength(1);
  });
});
