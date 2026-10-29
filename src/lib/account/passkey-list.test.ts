import { describe, expect, it, vi } from "vitest";
import { loadPasskeys } from "@/lib/account/passkey-list";

function stubDb(rows: unknown[]) {
  const findMany = vi.fn(async () => rows);
  return {
    db: { passkey: { findMany } } as unknown as Parameters<
      typeof loadPasskeys
    >[0],
    findMany,
  };
}

describe("loadPasskeys", () => {
  it("reads only the caller's rows, oldest first, without key material", async () => {
    const { db, findMany } = stubDb([]);
    await loadPasskeys(db, "u1");
    expect(findMany).toHaveBeenCalledWith({
      where: { userId: "u1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, createdAt: true, backedUp: true },
    });
  });

  it("returns the date as an ISO string", async () => {
    const { db } = stubDb([
      {
        id: "p1",
        name: "MacBook",
        createdAt: new Date("2026-10-28T12:00:00.000Z"),
        backedUp: true,
      },
      {
        id: "p2",
        name: null,
        createdAt: new Date("2026-10-29T12:00:00.000Z"),
        backedUp: false,
      },
    ]);
    expect(await loadPasskeys(db, "u1")).toEqual([
      {
        id: "p1",
        name: "MacBook",
        createdAt: "2026-10-28T12:00:00.000Z",
        backedUp: true,
      },
      {
        id: "p2",
        name: null,
        createdAt: "2026-10-29T12:00:00.000Z",
        backedUp: false,
      },
    ]);
  });
});
