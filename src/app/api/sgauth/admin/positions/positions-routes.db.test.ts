import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({ getSession: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: async () => null,
}));

import { prisma } from "@/lib/prisma";
import {
  buildSessionEndpointDeps,
  type SessionAuth,
} from "@/lib/sgauth-session/handler";
import { createAdmin, createPosition, createUser } from "@/test/factories";
import { GET as listPositions, POST as createPositionRoute } from "./route";
import {
  DELETE as deletePositionRoute,
  GET as getPositionRoute,
  PATCH as patchPositionRoute,
} from "./[id]/route";

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = "http://localhost:3000/api/sgauth/admin/positions";

const { loadSubject } = buildSessionEndpointDeps({
  auth: {} as SessionAuth,
  prisma,
  limiter: { limitRequest: async () => null },
  log: { warn: () => {} },
});

const rand = Math.random().toString(36).slice(2, 8);
let keyCounter = 0;
const uniqueKey = () => `t54-${rand}-${(keyCounter += 1)}`;

function signInAs(user: { id: string }) {
  mocks.getSession.mockResolvedValue({ user: { id: user.id } });
}

function json(method: string, url: string, body?: unknown) {
  return new NextRequest(url, {
    method,
    headers: { "content-type": "application/json" },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

async function sessionPositions(userId: string) {
  return (await loadSubject(userId))?.positions;
}

function auditRows(positionId: string, type?: string) {
  return prisma.auditEvent.findMany({
    where: { targetType: "POSITION", targetId: positionId, type },
    orderBy: { createdAt: "asc" },
  });
}

async function holder(positionId: string) {
  const user = await createUser();
  await prisma.userPosition.create({
    data: { userId: user.id, positionId },
  });
  return user;
}

let admin: Awaited<ReturnType<typeof createAdmin>>;

beforeEach(async () => {
  mocks.getSession.mockReset();
  admin = await createAdmin({ twoFactorEnabled: true });
  signInAs(admin);
});

describe("renaming a position (AC 1)", () => {
  it("changes the name only and leaves the key and holders alone", async () => {
    const position = await createPosition();
    const u1 = await holder(position.id);
    const u2 = await holder(position.id);
    const beforeSession = [
      await sessionPositions(u1.id),
      await sessionPositions(u2.id),
    ];

    const response = await patchPositionRoute(
      json("PATCH", `${BASE}/${position.id}`, { name: "New Name" }),
      ctx(position.id),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");

    const row = await prisma.position.findUniqueOrThrow({
      where: { id: position.id },
    });
    expect(row.key).toBe(position.key);
    expect(row.name).toBe("New Name");
    expect(row.updatedById).toBe(admin.id);
    expect(
      await prisma.userPosition.count({ where: { positionId: position.id } }),
    ).toBe(2);

    const afterSession = [
      await sessionPositions(u1.id),
      await sessionPositions(u2.id),
    ];
    expect(afterSession).toEqual(
      beforeSession.map((positions) =>
        positions?.map((p) => ({ ...p, name: "New Name" })),
      ),
    );

    const rows = await auditRows(position.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "POSITION_UPDATED",
      actorUserId: admin.id,
      metadata: {
        before: { name: position.name },
        after: { name: "New Name" },
      },
    });
  });

  it("refuses a body that names the key", async () => {
    const position = await createPosition();
    const response = await patchPositionRoute(
      json("PATCH", `${BASE}/${position.id}`, { key: "other-key" }),
      ctx(position.id),
    );
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "KEY_IMMUTABLE" });
  });

  it("writes no audit row for a no-op", async () => {
    const position = await createPosition();
    const response = await patchPositionRoute(
      json("PATCH", `${BASE}/${position.id}`, { name: position.name }),
      ctx(position.id),
    );
    expect(response.status).toBe(200);
    expect(await auditRows(position.id)).toHaveLength(0);
  });

  it("refuses to update a deleted position", async () => {
    const position = await createPosition({ deletedAt: new Date() });
    const response = await patchPositionRoute(
      json("PATCH", `${BASE}/${position.id}`, { name: "Whatever" }),
      ctx(position.id),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "POSITION_DELETED" });
  });
});

describe("deleting a position (AC 2)", () => {
  it("needs the matching confirmKey, then retires the key and keeps the holders", async () => {
    const position = await createPosition();
    const u1 = await holder(position.id);
    const u2 = await holder(position.id);
    expect(await sessionPositions(u1.id)).toHaveLength(1);

    const preflight = await getPositionRoute(
      json("GET", `${BASE}/${position.id}`),
      ctx(position.id),
    );
    expect(preflight.status).toBe(200);
    expect(await preflight.json()).toMatchObject({
      position: { id: position.id, holderCount: 2, deletedAt: null },
    });

    const url = `${BASE}/${position.id}`;
    const noBody = await deletePositionRoute(
      new NextRequest(url, { method: "DELETE" }),
      ctx(position.id),
    );
    expect(noBody.status).toBe(400);
    expect(await noBody.json()).toMatchObject({ code: "INVALID_INPUT" });

    const wrong = await deletePositionRoute(
      json("DELETE", url, { confirmKey: "WRONG" }),
      ctx(position.id),
    );
    expect(wrong.status).toBe(400);
    expect(await wrong.json()).toMatchObject({ code: "CONFIRM_KEY_MISMATCH" });
    expect(
      (await prisma.position.findUniqueOrThrow({ where: { id: position.id } }))
        .deletedAt,
    ).toBeNull();

    const ok = await deletePositionRoute(
      json("DELETE", url, { confirmKey: position.key }),
      ctx(position.id),
    );
    expect(ok.status).toBe(200);
    expect(await ok.json()).toMatchObject({ holderCount: 2 });

    const row = await prisma.position.findUniqueOrThrow({
      where: { id: position.id },
    });
    expect(row.deletedAt).not.toBeNull();
    const retired = await prisma.retiredPositionKey.findMany({
      where: { positionId: position.id },
    });
    expect(retired).toHaveLength(1);
    expect(retired[0]?.key).toBe(position.key);
    expect(
      await prisma.userPosition.count({ where: { positionId: position.id } }),
    ).toBe(2);

    expect(await sessionPositions(u1.id)).toEqual([]);
    expect(await sessionPositions(u2.id)).toEqual([]);

    const rows = await auditRows(position.id, "POSITION_DELETED");
    expect(rows).toHaveLength(1);
    expect(rows[0]?.metadata).toMatchObject({
      before: { key: position.key, name: position.name },
    });
    const metadata = rows[0]?.metadata as { holderIds: string[] };
    expect([...metadata.holderIds].sort()).toEqual([u1.id, u2.id].sort());

    const again = await deletePositionRoute(
      json("DELETE", url, { confirmKey: position.key }),
      ctx(position.id),
    );
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ code: "POSITION_DELETED" });
  });
});

describe("creating a position (AC 3)", () => {
  async function retiredKey(daysAgo: number) {
    const key = uniqueKey();
    const position = await createPosition({
      key,
      deletedAt: new Date(Date.now() - daysAgo * DAY_MS),
    });
    await prisma.retiredPositionKey.create({
      data: {
        positionId: position.id,
        key,
        retiredAt: new Date(Date.now() - daysAgo * DAY_MS),
      },
    });
    return key;
  }

  it("refuses a key retired 100 days ago with KEY_RETIRED", async () => {
    const key = await retiredKey(100);
    const response = await createPositionRoute(
      json("POST", BASE, { key, name: "Reused" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "KEY_RETIRED" });
  });

  it("accepts a key retired 400 days ago and audits it", async () => {
    const key = await retiredKey(400);
    const response = await createPositionRoute(
      json("POST", BASE, { key, name: "Reused" }),
    );
    expect(response.status).toBe(201);
    const { position } = await response.json();
    expect(position).toMatchObject({ key, name: "Reused", holderCount: 0 });

    const rows = await auditRows(position.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      type: "POSITION_CREATED",
      actorUserId: admin.id,
      metadata: {
        after: { key, name: "Reused", category: null, description: null },
      },
    });
  });

  it("refuses a key an active position holds with KEY_TAKEN", async () => {
    const existing = await createPosition();
    const response = await createPositionRoute(
      json("POST", BASE, { key: existing.key, name: "Duplicate" }),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "KEY_TAKEN" });
  });
});

describe("leadership and manager", () => {
  const patch = (id: string, body: unknown) =>
    patchPositionRoute(json("PATCH", `${BASE}/${id}`, body), ctx(id));

  it("creates a position with leadership and a manager, and audits both", async () => {
    const manager = await createPosition();
    const response = await createPositionRoute(
      json("POST", BASE, {
        key: uniqueKey(),
        name: "Reports Up",
        isLeadership: true,
        managerPositionId: manager.id,
      }),
    );
    expect(response.status).toBe(201);
    const { position } = await response.json();
    expect(position).toMatchObject({
      isLeadership: true,
      managerPositionId: manager.id,
      reportCount: 0,
    });
    const rows = await auditRows(position.id);
    expect(rows[0]?.metadata).toMatchObject({
      after: { isLeadership: true, managerPositionId: manager.id },
    });
  });

  it("defaults a new position to non-leadership with no manager", async () => {
    const response = await createPositionRoute(
      json("POST", BASE, { key: uniqueKey(), name: "Plain" }),
    );
    expect(response.status).toBe(201);
    expect((await response.json()).position).toMatchObject({
      isLeadership: false,
      managerPositionId: null,
    });
  });

  it("refuses a create under a missing or deleted manager", async () => {
    const deleted = await createPosition({ deletedAt: new Date() });
    for (const managerPositionId of [
      deleted.id,
      "0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e",
    ]) {
      const response = await createPositionRoute(
        json("POST", BASE, {
          key: uniqueKey(),
          name: "Orphan",
          managerPositionId,
        }),
      );
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "MANAGER_NOT_FOUND",
      });
    }
  });

  it("updates leadership and manager, audits the change and counts the report", async () => {
    const boss = await createPosition();
    const report = await createPosition();

    const response = await patch(report.id, {
      isLeadership: true,
      managerPositionId: boss.id,
    });
    expect(response.status).toBe(200);
    expect((await response.json()).position).toMatchObject({
      isLeadership: true,
      managerPositionId: boss.id,
    });
    const rows = await auditRows(report.id, "POSITION_UPDATED");
    expect(rows[0]?.metadata).toMatchObject({
      before: { isLeadership: false, managerPositionId: null },
      after: { isLeadership: true, managerPositionId: boss.id },
    });

    const preflight = await getPositionRoute(
      json("GET", `${BASE}/${boss.id}`),
      ctx(boss.id),
    );
    expect((await preflight.json()).position).toMatchObject({ reportCount: 1 });

    const cleared = await patch(report.id, { managerPositionId: null });
    expect(cleared.status).toBe(200);
    expect(
      (await prisma.position.findUniqueOrThrow({ where: { id: report.id } }))
        .managerPositionId,
    ).toBeNull();
  });

  it("refuses a manager that is the position itself or sits below it, and writes nothing", async () => {
    const top = await createPosition();
    const middle = await createPosition({ managerPositionId: top.id });
    const bottom = await createPosition({ managerPositionId: middle.id });

    for (const [id, managerPositionId] of [
      [top.id, top.id],
      [top.id, middle.id],
      [top.id, bottom.id],
    ]) {
      const response = await patch(id, { managerPositionId });
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({ code: "MANAGER_CYCLE" });
    }
    expect(
      (await prisma.position.findUniqueOrThrow({ where: { id: top.id } }))
        .managerPositionId,
    ).toBeNull();
    expect(await auditRows(top.id, "POSITION_UPDATED")).toHaveLength(0);
  });

  it("refuses a deleted manager and a manager that is not a UUID", async () => {
    const position = await createPosition();
    const deleted = await createPosition({ deletedAt: new Date() });

    const gone = await patch(position.id, { managerPositionId: deleted.id });
    expect(gone.status).toBe(409);
    expect(await gone.json()).toMatchObject({ code: "MANAGER_NOT_FOUND" });

    const malformed = await patch(position.id, { managerPositionId: "nope" });
    expect(malformed.status).toBe(400);
    expect(await malformed.json()).toMatchObject({ code: "INVALID_INPUT" });
  });

  it("clears the manager of reports when their manager is deleted, and audits their ids", async () => {
    const boss = await createPosition();
    const r1 = await createPosition({ managerPositionId: boss.id });
    const r2 = await createPosition({ managerPositionId: boss.id });

    const response = await deletePositionRoute(
      json("DELETE", `${BASE}/${boss.id}`, { confirmKey: boss.key }),
      ctx(boss.id),
    );
    expect(response.status).toBe(200);

    for (const report of [r1, r2]) {
      expect(
        (await prisma.position.findUniqueOrThrow({ where: { id: report.id } }))
          .managerPositionId,
      ).toBeNull();
    }
    const rows = await auditRows(boss.id, "POSITION_DELETED");
    const { reportIds } = rows[0]?.metadata as { reportIds: string[] };
    expect([...reportIds].sort()).toEqual([r1.id, r2.id].sort());
  });
});

describe("admin MFA", () => {
  it("refuses an admin who has not enrolled, then accepts them once enrolled", async () => {
    const unenrolled = await createAdmin({ twoFactorEnabled: false });
    signInAs(unenrolled);
    const key = uniqueKey();

    const read = await listPositions(json("GET", BASE));
    expect(read.status).toBe(403);
    expect(await read.json()).toMatchObject({
      code: "MFA_REQUIRED",
      enrollmentUrl: "/account/security",
    });

    const write = await createPositionRoute(
      json("POST", BASE, { key, name: "Blocked" }),
    );
    expect(write.status).toBe(403);
    expect(await write.json()).toMatchObject({ code: "MFA_REQUIRED" });
    expect(await prisma.position.count({ where: { key } })).toBe(0);

    await prisma.user.update({
      where: { id: unenrolled.id },
      data: { twoFactorEnabled: true },
    });
    const retry = await createPositionRoute(
      json("POST", BASE, { key, name: "Allowed" }),
    );
    expect(retry.status).toBe(201);
    const { position } = await retry.json();
    // The refused POST wrote nothing; the retry wrote exactly one row.
    expect(await auditRows(position.id)).toHaveLength(1);
  });
});

describe("listing positions", () => {
  it("excludes deleted positions unless asked, ordered by category then key", async () => {
    const category = `t54-${rand}-cat`;
    const b = await createPosition({ key: `${category}-b`, category });
    const a = await createPosition({ key: `${category}-a`, category });
    const uncategorized = await createPosition({ key: uniqueKey() });
    const deleted = await createPosition({
      key: `${category}-c`,
      category,
      deletedAt: new Date(),
    });

    const ids = async (query = "") => {
      const response = await listPositions(json("GET", `${BASE}${query}`));
      expect(response.status).toBe(200);
      const { positions } = await response.json();
      return positions.map((p: { id: string }) => p.id) as string[];
    };
    const ours = new Set([a.id, b.id, uncategorized.id, deleted.id]);

    const active = (await ids()).filter((id) => ours.has(id));
    expect(active).toEqual([a.id, b.id, uncategorized.id]);
    expect(active).not.toContain(deleted.id);

    const all = (await ids("?includeDeleted=true")).filter((id) =>
      ours.has(id),
    );
    expect(all).toContain(deleted.id);
    expect(all.at(-1)).toBe(uncategorized.id);

    const bad = await listPositions(json("GET", `${BASE}?includeDeleted=yes`));
    expect(bad.status).toBe(400);
  });
});

describe("refusals", () => {
  it("answers 403 NOT_ADMIN for a non-admin and writes no audit row", async () => {
    const user = await createUser();
    signInAs(user);
    const key = uniqueKey();
    const response = await createPositionRoute(
      json("POST", BASE, { key, name: "Nope" }),
    );
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({ code: "NOT_ADMIN" });
    expect(await prisma.position.count({ where: { key } })).toBe(0);
  });

  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    const response = await listPositions(json("GET", BASE));
    expect(response.status).toBe(401);
  });

  it.each([
    ["a random uuid", "0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e"],
    ["a malformed id", "not-a-uuid"],
  ])("answers 404 for %s", async (_label, id) => {
    const response = await getPositionRoute(
      json("GET", `${BASE}/${id}`),
      ctx(id),
    );
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "POSITION_NOT_FOUND" });
  });
});
