import { describe, expect, it, vi } from "vitest";
import { encodeCursor } from "@/lib/audit-log";
import {
  HISTORY_ERRORS,
  getPositionHistory,
  getUserPositionHistory,
  historyIdSchema,
  historyQuerySchema,
  type PositionHistoryDb,
} from "@/lib/position-history";

const UUID = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7b";
const UUID_2 = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7c";
const AT = new Date("2026-10-20T12:00:00.000Z");

const parse = (raw: unknown) => historyQuerySchema.safeParse(raw);

describe("historyQuerySchema", () => {
  it("defaults the limit to 50", () => {
    const result = parse({});
    expect(result.success && result.data.limit).toBe(50);
  });

  it("accepts 1 to 100", () => {
    expect(parse({ limit: "1" }).success).toBe(true);
    expect(parse({ limit: "100" }).success).toBe(true);
  });

  it.each(["0", "101", "abc", "1.5"])("rejects limit %s", (limit) => {
    expect(parse({ limit }).success).toBe(false);
  });

  it("decodes a cursor", () => {
    const result = parse({ cursor: encodeCursor({ createdAt: AT, id: UUID }) });
    expect(result.success && result.data.cursor).toEqual({
      createdAt: AT,
      id: UUID,
    });
  });

  it.each([
    ["not base64url", "not a cursor!"],
    ["no separator", Buffer.from("nothing").toString("base64url")],
    [
      "a bad date",
      Buffer.from(`2026-13-45T00:00:00.000Z|${UUID}`).toString("base64url"),
    ],
    [
      "a non-uuid id",
      Buffer.from(`${AT.toISOString()}|abc`).toString("base64url"),
    ],
    ["too long", "a".repeat(201)],
  ])("fails on the cursor path for %s", (_name, cursor) => {
    const result = parse({ cursor });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.issues.map((i) => i.path)).toEqual([["cursor"]]);
    }
  });
});

describe("historyIdSchema", () => {
  it("accepts a uuid and rejects anything else", () => {
    expect(historyIdSchema.safeParse(UUID).success).toBe(true);
    expect(historyIdSchema.safeParse("not-a-uuid").success).toBe(false);
  });
});

describe("HISTORY_ERRORS", () => {
  it("has fixed copy per code", () => {
    expect(HISTORY_ERRORS).toStrictEqual({
      INVALID_INPUT: { status: 400, message: "Invalid request parameters." },
      POSITION_NOT_FOUND: { status: 404, message: "Position not found." },
      USER_NOT_FOUND: { status: 404, message: "User not found." },
    });
  });
});

describe("getPositionHistory and getUserPositionHistory", () => {
  const fakeDb = (found: { position?: object | null; user?: object | null }) =>
    ({
      position: {
        findUnique: vi.fn().mockResolvedValue(found.position ?? null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      user: {
        findUnique: vi.fn().mockResolvedValue(found.user ?? null),
        findMany: vi.fn().mockResolvedValue([]),
      },
      $queryRaw: vi.fn().mockResolvedValue([]),
    }) as unknown as PositionHistoryDb & {
      $queryRaw: ReturnType<typeof vi.fn>;
    };

  // The values a tagged-template call bound, with nested Prisma.sql fragments
  // flattened in order.
  const boundValues = (call: unknown[]): unknown[] =>
    call.slice(1).flatMap((value) => {
      const nested = (value as { values?: unknown[] } | null)?.values;
      return Array.isArray(nested) ? boundValues([null, ...nested]) : [value];
    });

  it("returns null for an unknown position without querying events", async () => {
    const db = fakeDb({});
    expect(await getPositionHistory(db, UUID, { limit: 50 })).toBeNull();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns null for an unknown user without querying events", async () => {
    const db = fakeDb({});
    expect(await getUserPositionHistory(db, UUID, { limit: 50 })).toBeNull();
    expect(db.$queryRaw).not.toHaveBeenCalled();
  });

  it("returns an empty page with no cursor when there are no events", async () => {
    const db = fakeDb({ position: { id: UUID }, user: { id: UUID_2 } });
    expect(await getPositionHistory(db, UUID, { limit: 50 })).toEqual({
      events: [],
      nextCursor: null,
    });
    expect(await getUserPositionHistory(db, UUID_2, { limit: 50 })).toEqual({
      events: [],
      nextCursor: null,
    });
  });

  it("asks the user query for one row past the limit and keys on the cursor", async () => {
    const db = fakeDb({ user: { id: UUID_2 } });
    await getUserPositionHistory(db, UUID_2, {
      limit: 10,
      cursor: { createdAt: AT, id: UUID },
    });
    expect(db.$queryRaw).toHaveBeenCalledTimes(1);
    const call = db.$queryRaw.mock.calls[0];
    expect(boundValues(call)).toEqual([UUID_2, AT.toISOString(), UUID, 11]);
    const sql = (call[0] as string[]).join("?");
    expect(sql).not.toContain('"ip"');
    expect(sql).not.toContain('"userAgent"');
  });

  it("answers a page with two database calls: the existence check and one query", async () => {
    const db = fakeDb({ position: { id: UUID }, user: { id: UUID_2 } });
    await getPositionHistory(db, UUID, { limit: 50 });
    await getUserPositionHistory(db, UUID_2, { limit: 50 });
    expect(db.$queryRaw).toHaveBeenCalledTimes(2);
    const lookups = [
      db.position.findUnique,
      db.user.findUnique,
    ] as unknown as ReturnType<typeof vi.fn>[];
    for (const lookup of lookups) expect(lookup).toHaveBeenCalledTimes(1);
  });
});
