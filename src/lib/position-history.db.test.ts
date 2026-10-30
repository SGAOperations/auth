import { beforeAll, describe, expect, it } from "vitest";
import { parseAuditEvent } from "@/lib/audit";
import { decodeCursor } from "@/lib/audit-log";
import {
  getPositionHistory,
  getUserPositionHistory,
  type PositionHistoryEvent,
} from "@/lib/position-history";
import { prisma } from "@/lib/prisma";
import { createAdmin, createPosition, createUser } from "@/test/factories";

type Created = Awaited<ReturnType<typeof createUser>>;

const BASE = new Date("2026-01-01T00:00:00.000Z");
const at = (seconds: number) => new Date(BASE.getTime() + seconds * 1000);

const snapshot = {
  key: "k",
  name: "Name",
  category: null,
  description: null,
};

interface AuditSeed {
  type: string;
  actorType: string;
  actorUserId: string;
  targetType: string;
  targetId: string;
  metadata: Record<string, unknown>;
}

const lifecycle = (
  type: string,
  positionId: string,
  actorId: string,
): AuditSeed => ({
  type,
  actorType: "USER",
  actorUserId: actorId,
  targetType: "POSITION",
  targetId: positionId,
  metadata:
    type === "POSITION_CREATED"
      ? { after: snapshot }
      : type === "POSITION_UPDATED"
        ? { before: { name: "Old" }, after: { name: "New" } }
        : {
            before: snapshot,
            after: { deletedAt: BASE.toISOString() },
            holderIds: [],
          },
});

const membership = (
  type: string,
  positionId: string,
  userId: string,
  actorId: string,
): AuditSeed => ({
  type,
  actorType: "USER",
  actorUserId: actorId,
  targetType: "USER",
  targetId: userId,
  metadata: { positionId },
});

// AuditEvent is append-only and never emptied, so every assertion is narrowed
// to the ids this run created.
describe("position history", () => {
  let admin: Created;
  let u1: Created;
  let u2: Created;
  let p: Awaited<ReturnType<typeof createPosition>>;
  let q: Awaited<ReturnType<typeof createPosition>>;
  let sequence: string[];

  // Written with explicit, distinct timestamps so the order is exact.
  const write = (input: unknown, seconds: number) =>
    prisma.auditEvent.create({
      data: { ...parseAuditEvent(input), createdAt: at(seconds) },
    });

  const pageAll = async (limit: number) => {
    const ids: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    do {
      const page = await getPositionHistory(prisma, p.id, {
        limit,
        cursor: cursor ?? undefined,
      });
      if (!page) throw new Error("position vanished");
      ids.push(...page.events.map((event) => event.id));
      cursor = page.nextCursor ? decodeCursor(page.nextCursor) : null;
    } while (cursor);
    return ids;
  };

  beforeAll(async () => {
    admin = await createAdmin();
    u1 = await createUser();
    u2 = await createUser();
    p = await createPosition();
    q = await createPosition();

    const events = [
      lifecycle("POSITION_CREATED", p.id, admin.id),
      lifecycle("POSITION_UPDATED", p.id, admin.id),
      membership("POSITION_ASSIGNED", p.id, u1.id, admin.id),
      membership("POSITION_ASSIGNED", p.id, u2.id, admin.id),
      membership("POSITION_UNASSIGNED", p.id, u1.id, admin.id),
      membership("POSITION_ASSIGNED", q.id, u1.id, admin.id),
      lifecycle("POSITION_DELETED", p.id, admin.id),
    ];
    sequence = [];
    for (const [i, event] of events.entries()) {
      const row = await write(event, i);
      if (event.targetId === p.id || event.metadata.positionId === p.id) {
        sequence.push(row.id);
      }
    }
    // Noise: not a position event at all.
    await write(
      {
        type: "LOGIN_SUCCESS",
        actorType: "USER",
        actorUserId: u1.id,
        targetType: "USER",
        targetId: u1.id,
        metadata: { method: "password" },
      },
      100,
    );
    await prisma.position.update({
      where: { id: p.id },
      data: { deletedAt: at(6) },
    });
  });

  it("returns a position's own events newest first, and nothing else", async () => {
    const page = await getPositionHistory(prisma, p.id, { limit: 50 });
    expect(page?.events.map((e) => e.id)).toEqual([...sequence].reverse());
    expect(page?.nextCursor).toBeNull();
  });

  it("fills in the holder, the actor and the position", async () => {
    const page = await getPositionHistory(prisma, p.id, { limit: 50 });
    const events = page?.events ?? [];
    const byType = (type: string): PositionHistoryEvent[] =>
      events.filter((e) => e.type === type);

    for (const event of [
      ...byType("POSITION_ASSIGNED"),
      ...byType("POSITION_UNASSIGNED"),
    ]) {
      expect(event.user?.id).toMatch(/^[0-9a-f-]{36}$/);
    }
    expect(byType("POSITION_ASSIGNED").map((e) => e.user?.id)).toEqual([
      u2.id,
      u1.id,
    ]);
    expect(byType("POSITION_UNASSIGNED")[0].user?.email).toBe(u1.email);
    expect(events.every((e) => e.actor.user?.name === admin.name)).toBe(true);
    expect(byType("POSITION_CREATED")[0].user).toBeNull();
    expect(events.every((e) => e.position?.id === p.id)).toBe(true);
    expect(events[0].position?.deletedAt).toBe(at(6).toISOString());
    expect(JSON.stringify(events)).not.toContain("userAgent");
  });

  it("returns a user's assign and unassign events", async () => {
    const page = await getUserPositionHistory(prisma, u1.id, { limit: 50 });
    const events = page?.events ?? [];
    expect(events.map((e) => [e.type, e.position?.id])).toEqual([
      ["POSITION_ASSIGNED", q.id],
      ["POSITION_UNASSIGNED", p.id],
      ["POSITION_ASSIGNED", p.id],
    ]);
    expect(events[1].position?.key).toBe(p.key);
    expect(events.every((e) => e.user?.id === u1.id)).toBe(true);
  });

  it.each([1, 2, 3])(
    "pages a position's history with limit %i, each event once",
    async (limit) => {
      expect(await pageAll(limit)).toEqual([...sequence].reverse());
    },
  );

  it("pages a user's history with no gap and no duplicate", async () => {
    const ids: string[] = [];
    let cursor: ReturnType<typeof decodeCursor> = null;
    do {
      const page = await getUserPositionHistory(prisma, u1.id, {
        limit: 1,
        cursor: cursor ?? undefined,
      });
      ids.push(...(page?.events.map((e) => e.id) ?? []));
      cursor = page?.nextCursor ? decodeCursor(page.nextCursor) : null;
    } while (cursor);
    expect(ids).toHaveLength(3);
    expect(new Set(ids).size).toBe(3);
  });

  it("returns null for an unknown position or user", async () => {
    const unknown = "0192ab3c-4d5e-7f60-8a1b-000000000000";
    expect(await getPositionHistory(prisma, unknown, { limit: 5 })).toBeNull();
    expect(
      await getUserPositionHistory(prisma, unknown, { limit: 5 }),
    ).toBeNull();
  });

  it("gives a SYSTEM actor no user", async () => {
    const position = await createPosition();
    await prisma.auditEvent.create({
      data: {
        ...parseAuditEvent({
          type: "POSITION_CREATED",
          actorType: "SYSTEM",
          targetType: "POSITION",
          targetId: position.id,
          metadata: { after: snapshot },
        }),
        createdAt: at(1),
      },
    });
    const page = await getPositionHistory(prisma, position.id, { limit: 5 });
    expect(page?.events[0].actor).toEqual({ type: "SYSTEM", user: null });
  });
});

// The acceptance criterion. The rows are rolled back: AuditEvent can never be
// emptied, so 10k committed rows would stay for good.
describe("position history latency", () => {
  class Rollback extends Error {}
  const BUDGET_MS = 300;
  const ROWS = 10_000;

  it("answers a first page and a deep page in under 300 ms at 10k events", async () => {
    await prisma
      .$transaction(
        async (tx) => {
          const admin = await createAdmin({}, tx);
          const user = await createUser({}, tx);
          const position = await tx.position.create({
            data: { key: `latency-${Date.now()}`, name: "Latency" },
          });

          const rows: AuditSeed[] = [
            lifecycle("POSITION_CREATED", position.id, admin.id),
            ...Array.from({ length: 20 }, () =>
              lifecycle("POSITION_UPDATED", position.id, admin.id),
            ),
            ...Array.from({ length: ROWS }, (_, i) =>
              membership(
                i % 2 === 0 ? "POSITION_ASSIGNED" : "POSITION_UNASSIGNED",
                position.id,
                user.id,
                admin.id,
              ),
            ),
          ];
          await tx.auditEvent.createMany({
            data: rows.map((row, i) => ({
              ...parseAuditEvent(row),
              createdAt: at(i),
            })),
          });

          const [deep] = await tx.auditEvent.findMany({
            where: { targetId: user.id },
            orderBy: [{ createdAt: "desc" }, { id: "desc" }],
            skip: ROWS / 2,
            take: 1,
            select: { id: true, createdAt: true },
          });
          const deepCursor = { createdAt: deep.createdAt, id: deep.id };

          const calls = {
            "position first page": () =>
              getPositionHistory(tx, position.id, { limit: 50 }),
            "position deep page": () =>
              getPositionHistory(tx, position.id, {
                limit: 50,
                cursor: deepCursor,
              }),
            "user first page": () =>
              getUserPositionHistory(tx, user.id, { limit: 50 }),
            "user deep page": () =>
              getUserPositionHistory(tx, user.id, {
                limit: 50,
                cursor: deepCursor,
              }),
          };

          for (const [name, call] of Object.entries(calls)) {
            await call(); // warm-up
            const started = performance.now();
            const page = await call();
            const elapsed = performance.now() - started;
            expect(page?.events, name).toHaveLength(50);
            expect(elapsed, name).toBeLessThan(BUDGET_MS);
          }
          throw new Rollback();
        },
        { timeout: 120_000, maxWait: 30_000 },
      )
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  }, 120_000);
});
