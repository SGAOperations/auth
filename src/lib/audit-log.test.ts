import { describe, expect, it, vi } from "vitest";
import type { AuditEvent } from "@/generated/prisma/client";
import { AUDIT_EVENT_TYPES } from "@/lib/audit-catalog";
import {
  AUDIT_EXPORT_BATCH,
  AUDIT_PAGE_SIZE,
  auditLogFilterSchema,
  auditLogPageSchema,
  buildAuditWhere,
  csvCell,
  decodeCursor,
  encodeCursor,
  exportAuditCsv,
  listAuditEvents,
  paramsToRecord,
  resolveRefs,
  resolveUserFilter,
  serializeAuditFilter,
  zonedDayStart,
  type AuditLogDb,
  type AuditLogFilter,
} from "@/lib/audit-log";

const UUID = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7b";
const UUID_2 = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7c";

const parse = (raw: unknown) => auditLogFilterSchema.safeParse(raw);
const filterOf = (raw: unknown): AuditLogFilter => {
  const result = parse(raw);
  if (!result.success) throw result.error;
  return result.data;
};
const issuePaths = (raw: unknown) => {
  const result = parse(raw);
  return result.success ? [] : result.error.issues.map((i) => i.path.join("."));
};

describe("auditLogFilterSchema", () => {
  it("drops empty fields, as a GET form submits them", () => {
    expect(
      filterOf({
        type: "",
        user: "",
        userRole: "",
        actorType: "",
        from: "",
        to: "",
      }),
    ).toEqual({ type: [], userRole: "any" });
  });

  it("wraps a single type in an array and removes duplicates", () => {
    expect(filterOf({ type: "LOGOUT" }).type).toEqual(["LOGOUT"]);
    expect(
      filterOf({ type: ["LOGOUT", "LOGIN_SUCCESS", "LOGOUT"] }).type,
    ).toEqual(["LOGOUT", "LOGIN_SUCCESS"]);
  });

  it("rejects an unknown type", () => {
    expect(issuePaths({ type: "NOPE" })).toEqual(["type.0"]);
  });

  it("accepts a uuid and a mixed-case email, and lower-cases the email", () => {
    expect(filterOf({ user: UUID }).user).toBe(UUID);
    expect(filterOf({ user: " Ada@Northeastern.EDU " }).user).toBe(
      "ada@northeastern.edu",
    );
  });

  it.each(["bob", "a@", "x".repeat(255)])("rejects the user %j", (user) => {
    expect(issuePaths({ user })).toEqual(["user"]);
  });

  it("rejects a targetId without a targetType, on targetId", () => {
    expect(issuePaths({ targetId: "t1" })).toEqual(["targetId"]);
    expect(filterOf({ targetType: "SESSION", targetId: "t1" })).toMatchObject({
      targetType: "SESSION",
      targetId: "t1",
    });
  });

  it("rejects from after to, on to", () => {
    expect(issuePaths({ from: "2026-10-10", to: "2026-10-01" })).toEqual([
      "to",
    ]);
    expect(issuePaths({ from: "2026-10-01", to: "2026-10-01" })).toEqual([]);
  });

  it.each(["2026-02-30", "2026-13-01", "10/01/2026", "2026-1-1"])(
    "rejects the date %j",
    (from) => {
      expect(issuePaths({ from })).toEqual(["from"]);
    },
  );

  it("rejects an unknown role and a repeated scalar", () => {
    expect(issuePaths({ userRole: "both" })).toEqual(["userRole"]);
    expect(issuePaths({ actorType: ["USER", "SYSTEM"] })).toEqual([
      "actorType",
    ]);
  });
});

describe("auditLogPageSchema", () => {
  it("decodes the cursor and rejects a bad one on cursor", () => {
    const createdAt = new Date("2026-10-01T12:00:00.000Z");
    const parsed = auditLogPageSchema.parse({
      cursor: encodeCursor({ createdAt, id: UUID }),
    });
    expect(parsed.cursor).toEqual({ createdAt, id: UUID });

    const bad = auditLogPageSchema.safeParse({ cursor: "!!" });
    expect(bad.success).toBe(false);
    expect(!bad.success && bad.error.issues[0].path).toEqual(["cursor"]);
  });
});

describe("serializeAuditFilter", () => {
  const full = {
    type: ["LOGIN_SUCCESS", "LOGOUT"],
    user: UUID,
    userRole: "actor",
    actorType: "USER",
    targetType: "SESSION",
    targetId: "abc",
    from: "2026-10-01",
    to: "2026-10-31",
  };

  it("round-trips a fully populated filter", () => {
    const filter = filterOf(full);
    const params = serializeAuditFilter(filter);
    expect(auditLogFilterSchema.parse(paramsToRecord(params))).toEqual(filter);
  });

  it("round-trips the empty filter and writes nothing for it", () => {
    const filter = filterOf({});
    const params = serializeAuditFilter(filter);
    expect(params.toString()).toBe("");
    expect(auditLogFilterSchema.parse(paramsToRecord(params))).toEqual(filter);
  });

  it("omits defaults and writes one type entry per type", () => {
    const params = serializeAuditFilter(
      filterOf({ type: ["LOGOUT", "LOGIN_FAILED"], user: UUID }),
    );
    expect(params.toString()).toBe(
      `type=LOGOUT&type=LOGIN_FAILED&user=${UUID}`,
    );
  });
});

describe("zonedDayStart", () => {
  it.each([
    ["2026-07-01", "2026-07-01T04:00:00.000Z"],
    ["2026-12-01", "2026-12-01T05:00:00.000Z"],
    ["2026-03-08", "2026-03-08T05:00:00.000Z"],
    ["2026-11-01", "2026-11-01T04:00:00.000Z"],
  ])("%s starts at %s", (ymd, instant) => {
    expect(zonedDayStart(ymd, "America/New_York").toISOString()).toBe(instant);
  });
});

describe("buildAuditWhere", () => {
  const actor = { actorUserId: UUID };
  const target = { targetType: "USER", targetId: UUID };

  it.each([
    ["any", { AND: [{ OR: [actor, target] }] }],
    ["actor", { AND: [actor] }],
    ["target", { AND: [target] }],
  ] as const)("the %s role gives its clause", (userRole, where) => {
    expect(buildAuditWhere(filterOf({ user: UUID, userRole }), UUID)).toEqual(
      where,
    );
  });

  it("matches nothing for a user that does not exist", () => {
    expect(buildAuditWhere(filterOf({ user: "a@b.edu" }), null)).toEqual({
      id: { in: [] },
    });
  });

  it("ignores the resolved id when no user is filtered", () => {
    expect(buildAuditWhere(filterOf({}), UUID)).toEqual({ AND: [] });
  });

  it("combines every filter into one AND list, with an inclusive end date", () => {
    const where = buildAuditWhere(
      filterOf({
        type: ["LOGOUT"],
        user: UUID,
        actorType: "USER",
        targetType: "SESSION",
        targetId: "s1",
        from: "2026-07-01",
        to: "2026-07-31",
      }),
      UUID,
    );
    expect(where).toEqual({
      AND: [
        { OR: [actor, target] },
        { type: { in: ["LOGOUT"] } },
        { actorType: "USER" },
        { targetType: "SESSION" },
        { targetId: "s1" },
        {
          createdAt: {
            gte: new Date("2026-07-01T04:00:00.000Z"),
            lt: new Date("2026-08-01T04:00:00.000Z"),
          },
        },
      ],
    });
  });
});

describe("cursor", () => {
  const createdAt = new Date("2026-10-01T12:34:56.789Z");
  const encode = (text: string) => Buffer.from(text).toString("base64url");

  it("round-trips", () => {
    expect(decodeCursor(encodeCursor({ createdAt, id: UUID }))).toEqual({
      createdAt,
      id: UUID,
    });
  });

  it.each([
    ["no separator", encode(`${createdAt.toISOString()}${UUID}`)],
    ["two separators", encode(`${createdAt.toISOString()}|${UUID}|x`)],
    ["a bad date", encode(`not-a-date|${UUID}`)],
    ["a non-canonical date", encode(`2026-10-01|${UUID}`)],
    ["a non-uuid id", encode(`${createdAt.toISOString()}|abc`)],
    ["non-base64url input", "a+b/c="],
    ["an empty string", ""],
  ])("rejects %s", (_label, value) => {
    expect(decodeCursor(value)).toBeNull();
  });
});

describe("csvCell", () => {
  it.each([
    [null, ""],
    [undefined, ""],
    [7, "7"],
    ["plain", "plain"],
    ['say "hi"', '"say ""hi"""'],
    ["a,b", '"a,b"'],
    ["a\nb", '"a\nb"'],
    ["a\r\nb", '"a\r\nb"'],
    ["=SUM(1)", "'=SUM(1)"],
    ["=SUM(1,2)", `"'=SUM(1,2)"`],
    ["+1", "'+1"],
    ["-1", "'-1"],
    ["@cmd", "'@cmd"],
    ["\tx", "'\tx"],
    ["\rx", `"'\rx"`],
  ])("%j becomes %j", (value, cell) => {
    expect(csvCell(value)).toBe(cell);
  });
});

const row = (n: number, extra: Partial<AuditEvent> = {}): AuditEvent => ({
  id: `0192ab3c-4d5e-7f60-8a1b-${String(n).padStart(12, "0")}`,
  type: "LOGIN_SUCCESS",
  actorType: "USER",
  actorUserId: UUID,
  targetType: "USER",
  targetId: UUID_2,
  metadata: { method: "password" },
  ip: "203.0.113.7",
  userAgent: "vitest",
  createdAt: new Date(Date.UTC(2026, 9, 1, 0, 0, 0, 1000 - n)),
  ...extra,
});

function fakeDb(events: (take: number) => AuditEvent[] = () => []) {
  const mocks = {
    findEvents: vi.fn(({ take }: { take: number }) =>
      Promise.resolve(events(take)),
    ),
    findUsers: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    findPositions: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    findProducts: vi.fn((): Promise<unknown[]> => Promise.resolve([])),
    findUser: vi.fn((): Promise<unknown> => Promise.resolve(null)),
  };
  const db = {
    auditEvent: { findMany: mocks.findEvents },
    user: { findMany: mocks.findUsers, findUnique: mocks.findUser },
    position: { findMany: mocks.findPositions },
    product: { findMany: mocks.findProducts },
  } as unknown as AuditLogDb;
  return { db, ...mocks };
}

const manyRows = (count: number) => (take: number) =>
  Array.from({ length: Math.min(take, count) }, (_, i) => row(i + 1));

describe("listAuditEvents", () => {
  it("sets nextCursor only when a 51st row exists", async () => {
    const full = fakeDb(manyRows(AUDIT_PAGE_SIZE + 1));
    const more = await listAuditEvents(full.db, { AND: [] });
    expect(more.events).toHaveLength(AUDIT_PAGE_SIZE);
    expect(more.nextCursor).toBe(
      encodeCursor({
        createdAt: row(AUDIT_PAGE_SIZE).createdAt,
        id: row(AUDIT_PAGE_SIZE).id,
      }),
    );

    const exact = fakeDb(manyRows(AUDIT_PAGE_SIZE));
    expect(
      (await listAuditEvents(exact.db, { AND: [] })).nextCursor,
    ).toBeNull();
  });

  it("adds the keyset clause for a cursor", async () => {
    const { db, findEvents } = fakeDb();
    const cursor = {
      createdAt: new Date("2026-10-01T00:00:00.000Z"),
      id: UUID,
    };
    await listAuditEvents(db, { type: "X" }, cursor);
    expect(findEvents).toHaveBeenCalledWith({
      where: {
        AND: [
          { type: "X" },
          {
            OR: [
              { createdAt: { lt: cursor.createdAt } },
              { createdAt: cursor.createdAt, id: { lt: UUID } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: "desc" }, { id: "desc" }],
      take: AUDIT_PAGE_SIZE + 1,
    });
  });
});

describe("resolveRefs", () => {
  const POSITION = "0192ab3c-0000-7f60-8a1b-000000000001";
  const PRODUCT = "0192ab3c-0000-7f60-8a1b-000000000002";

  it("makes one lookup per kind however many rows there are", async () => {
    const fake = fakeDb();
    fake.findUsers.mockResolvedValue([
      {
        id: UUID,
        name: "Ada",
        email: "ada@northeastern.edu",
        status: "ACTIVE",
      },
    ]);
    fake.findPositions.mockResolvedValue([
      { id: POSITION, key: "treasurer", name: "Treasurer" },
    ]);
    fake.findProducts.mockResolvedValue([
      { id: PRODUCT, slug: "chambers", name: "Chambers" },
    ]);

    const rows = await resolveRefs(fake.db, [
      row(1),
      row(2),
      row(3, { targetType: "POSITION", targetId: POSITION }),
      row(4, { targetType: "PRODUCT", targetId: PRODUCT }),
      row(5, { actorType: "SYSTEM", actorUserId: null, targetType: "SESSION" }),
    ]);

    expect(fake.findUsers).toHaveBeenCalledTimes(1);
    expect(fake.findPositions).toHaveBeenCalledTimes(1);
    expect(fake.findProducts).toHaveBeenCalledTimes(1);
    expect(rows[0].actor.user).toEqual({
      id: UUID,
      name: "Ada",
      email: "ada@northeastern.edu",
      status: "ACTIVE",
    });
    // A missing user row keeps its id and nothing else.
    expect(rows[0].target?.user).toEqual({
      id: UUID_2,
      name: null,
      email: null,
      status: null,
    });
    expect(rows[2].target).toMatchObject({
      label: "Treasurer (treasurer)",
      user: null,
    });
    expect(rows[3].target?.label).toBe("Chambers (chambers)");
    expect(rows[4].actor).toEqual({ type: "SYSTEM", user: null });
    expect(rows[4].target?.label).toBeNull();
  });

  it("skips a lookup with nothing to look up", async () => {
    const fake = fakeDb();
    await resolveRefs(fake.db, [
      row(1, {
        actorType: "SYSTEM",
        actorUserId: null,
        targetType: null,
        targetId: null,
      }),
    ]);
    expect(fake.findUsers).not.toHaveBeenCalled();
    expect(fake.findPositions).not.toHaveBeenCalled();
    expect(fake.findProducts).not.toHaveBeenCalled();
  });
});

describe("resolveUserFilter", () => {
  it("uses a uuid whether or not the user exists", async () => {
    const fake = fakeDb();
    expect(await resolveUserFilter(fake.db, UUID)).toEqual({
      id: UUID,
      found: false,
    });
    fake.findUser.mockResolvedValue({ id: UUID });
    expect(await resolveUserFilter(fake.db, UUID)).toEqual({
      id: UUID,
      found: true,
    });
  });

  it("looks an email up and returns null on a miss", async () => {
    const fake = fakeDb();
    expect(await resolveUserFilter(fake.db, "a@b.edu")).toBeNull();
    fake.findUser.mockResolvedValue({ id: UUID_2 });
    expect(await resolveUserFilter(fake.db, "a@b.edu")).toEqual({
      id: UUID_2,
      found: true,
    });
  });
});

async function collect(stream: AsyncIterable<string>) {
  const chunks: string[] = [];
  for await (const chunk of stream) chunks.push(chunk);
  return chunks;
}

describe("exportAuditCsv", () => {
  it("starts with a BOM and the header", async () => {
    const { db } = fakeDb();
    const [first] = await collect(exportAuditCsv(db, { AND: [] }));
    expect(first).toBe(
      "﻿id,createdAt,type,actorType,actorUserId,actorName,actorEmail,targetType,targetId,targetLabel,ip,userAgent,metadata\r\n",
    );
  });

  it("stops at the cap", async () => {
    const { db, findEvents } = fakeDb(manyRows(100));
    const chunks = await collect(exportAuditCsv(db, { AND: [] }, 5));
    const lines = chunks.join("").split("\r\n").filter(Boolean);
    expect(lines).toHaveLength(1 + 5);
    expect(findEvents).toHaveBeenCalledTimes(1);
    expect(findEvents.mock.calls[0][0].take).toBe(5);
  });

  it("stops on a short batch", async () => {
    const { db, findEvents } = fakeDb(manyRows(3));
    const lines = (await collect(exportAuditCsv(db, { AND: [] })))
      .join("")
      .split("\r\n")
      .filter(Boolean);
    expect(lines).toHaveLength(1 + 3);
    expect(findEvents).toHaveBeenCalledTimes(1);
  });

  it("pages by keyset until the cap", async () => {
    const { db, findEvents } = fakeDb(manyRows(AUDIT_EXPORT_BATCH));
    const chunks = await collect(
      exportAuditCsv(db, { AND: [] }, AUDIT_EXPORT_BATCH + 10),
    );
    expect(findEvents).toHaveBeenCalledTimes(2);
    expect(findEvents.mock.calls[1][0].take).toBe(10);
    expect(findEvents.mock.calls[1][0]).toHaveProperty("where.AND.1.OR");
    expect(chunks).toHaveLength(3);
  });

  it("writes metadata as JSON and quotes it", async () => {
    const { db } = fakeDb(manyRows(1));
    const text = (await collect(exportAuditCsv(db, { AND: [] }))).join("");
    expect(text).toContain('"{""method"":""password""}"');
  });
});

describe("the event types", () => {
  it("are all accepted by the filter", () => {
    expect(filterOf({ type: [...AUDIT_EVENT_TYPES] }).type).toHaveLength(
      AUDIT_EVENT_TYPES.length,
    );
  });
});
