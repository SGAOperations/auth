import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Prisma } from "@/generated/prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import {
  AUDIT_PAGE_SIZE,
  auditLogFilterSchema,
  buildAuditWhere,
  decodeCursor,
  exportAuditCsv,
  listAuditEvents,
  resolveUserFilter,
} from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { createAdmin, createUser } from "@/test/factories";

type Created = Awaited<ReturnType<typeof createUser>>;

// AuditEvent is append-only and never emptied, so every query is narrowed to
// the users this run created.
describe("audit log queries", () => {
  let admin: Created;
  let u: Created;
  let v: Created;
  let scope: Prisma.AuditEventWhereInput;
  const session = `session-${Math.random().toString(36).slice(2, 10)}`;
  const BULK = AUDIT_PAGE_SIZE + 10;

  const filterOf = (raw: Record<string, string | string[]>) =>
    auditLogFilterSchema.parse(raw);

  async function where(raw: Record<string, string | string[]>) {
    const filter = filterOf(raw);
    const user = filter.user
      ? await resolveUserFilter(prisma, filter.user)
      : undefined;
    return {
      AND: [buildAuditWhere(filter, user?.id ?? null), scope],
    } satisfies Prisma.AuditEventWhereInput;
  }

  async function listAll(w: Prisma.AuditEventWhereInput) {
    const ids: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    do {
      const page = await listAuditEvents(prisma, w, cursor ?? undefined);
      ids.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor ? decodeCursor(page.nextCursor) : null;
    } while (cursor);
    return ids;
  }

  async function exportedIds(w: Prisma.AuditEventWhereInput, cap?: number) {
    let text = "";
    for await (const chunk of exportAuditCsv(prisma, w, cap)) text += chunk;
    return text
      .split("\r\n")
      .slice(1)
      .filter(Boolean)
      .map((line) => line.split(",")[0]);
  }

  async function types(w: Prisma.AuditEventWhereInput) {
    const rows = await prisma.auditEvent.findMany({ where: w });
    return rows.map((row) => row.type).sort();
  }

  beforeAll(async () => {
    admin = await createAdmin();
    u = await createUser();
    v = await createUser();
    scope = {
      OR: [
        { actorUserId: { in: [admin.id, u.id, v.id] } },
        { targetId: { in: [admin.id, u.id, v.id] } },
      ],
    };

    const user = (id: string) =>
      ({ actorType: "USER", actorUserId: id }) as const;
    const target = (id: string) =>
      ({ targetType: "USER", targetId: id }) as const;
    const password = { method: "password" };

    await writeAuditEvent(prisma, {
      type: "ADMIN_GRANTED",
      ...user(admin.id),
      ...target(u.id),
    });
    await writeAuditEvent(prisma, {
      type: "LOGIN_SUCCESS",
      ...user(u.id),
      ...target(u.id),
      metadata: password,
    });
    await writeAuditEvent(prisma, {
      type: "LOGOUT",
      ...user(u.id),
      targetType: "SESSION",
      targetId: session,
    });
    await writeAuditEvent(prisma, {
      type: "LOGIN_SUCCESS",
      ...user(v.id),
      ...target(v.id),
      metadata: password,
    });
    await writeAuditEvent(prisma, {
      type: "LOGIN_FAILED",
      actorType: "SYSTEM",
      ...target(u.id),
      metadata: { reason: "INVALID_EMAIL_OR_PASSWORD" },
    });
    // Enough rows for V to span two pages, all sharing one timestamp.
    await prisma.auditEvent.createMany({
      data: Array.from({ length: BULK }, () => ({
        type: "LOGIN_SUCCESS",
        actorType: "USER" as const,
        actorUserId: v.id,
        targetType: "USER" as const,
        targetId: v.id,
        metadata: password,
      })),
    });
  });

  afterAll(async () => {
    await prisma.user.deleteMany({
      where: { id: { in: [admin.id, u.id, v.id] } },
    });
  });

  it("shows events a user performed and events targeting them", async () => {
    const byEmail = await where({ user: u.email.toUpperCase() });
    expect(await types(byEmail)).toEqual([
      "ADMIN_GRANTED",
      "LOGIN_FAILED",
      "LOGIN_SUCCESS",
      "LOGOUT",
    ]);
    expect(await types(await where({ user: u.id, userRole: "actor" }))).toEqual(
      ["LOGIN_SUCCESS", "LOGOUT"],
    );
    expect(
      await types(await where({ user: u.id, userRole: "target" })),
    ).toEqual(["ADMIN_GRANTED", "LOGIN_FAILED", "LOGIN_SUCCESS"]);
  });

  it("matches nothing for an unknown email", async () => {
    expect(
      await resolveUserFilter(prisma, "nobody-at-all@northeastern.edu"),
    ).toBeNull();
    const w = {
      AND: [
        buildAuditWhere(
          filterOf({ user: "nobody-at-all@northeastern.edu" }),
          null,
        ),
        scope,
      ],
    };
    expect(await listAll(w)).toEqual([]);
  });

  it("resolves an unknown user id without a user row", async () => {
    const id = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7b";
    expect(await resolveUserFilter(prisma, id)).toEqual({ id, found: false });
  });

  const today = new Intl.DateTimeFormat("en-CA", {
    timeZone: "America/New_York",
  }).format(new Date());

  it.each([
    ["a user", () => ({ user: v.id })],
    [
      "a type and today's date",
      () => ({ type: "LOGIN_SUCCESS", from: today, to: today }),
    ],
    ["the system actor", () => ({ actorType: "SYSTEM" })],
  ])(
    "exports the same ids in the same order as the table for %s",
    async (_label, raw) => {
      const w = await where(raw());
      const listed = await listAll(w);
      expect(listed.length).toBeGreaterThan(0);
      expect(await exportedIds(w)).toEqual(listed);
    },
  );

  it("pages through more than one page", async () => {
    const w = await where({ user: v.id });
    const first = await listAuditEvents(prisma, w);
    expect(first.events).toHaveLength(AUDIT_PAGE_SIZE);
    expect(first.nextCursor).not.toBeNull();
    expect(await listAll(w)).toHaveLength(BULK + 1);
  });

  it("stops the export at the cap", async () => {
    expect(await exportedIds(await where({ user: v.id }), 2)).toHaveLength(2);
  });
});
