import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server", async () => {
  return (await import("@/test/admin-http")).authServerMock;
});
vi.mock("@/lib/rate-limit/server", async () => {
  return (await import("@/test/admin-http")).rateLimitServerMock;
});
vi.mock("next/headers", async () => {
  return (await import("@/test/admin-http")).nextHeadersMock;
});

import { prisma } from "@/lib/prisma";
import {
  buildSessionEndpointDeps,
  type SessionAuth,
} from "@/lib/sgauth-session/handler";
import {
  API,
  auditTracker,
  callRoute,
  codeOf,
  signIn,
} from "@/test/admin-http";
import { createAdmin, createUser } from "@/test/factories";
import { PATCH as assignToUser } from "../users/[id]/positions/route";
import { POST as createPosition } from "./route";
import { DELETE as deletePosition, PATCH as patchPosition } from "./[id]/route";
import { POST as assignHolders } from "./[id]/holders/route";

// One position's whole life across the CRUD routes (#54) and the assignment
// routes (#55), through the real guard and handlers. The rows are committed,
// which is fine here: no Primary Admin is involved, and every key and user is
// new to this run.

const DAY_MS = 24 * 60 * 60 * 1000;

const { loadSubject } = buildSessionEndpointDeps({
  auth: {} as SessionAuth,
  prisma,
  limiter: { limitRequest: async () => null },
  log: { warn: () => {} },
});

const sessionPositions = async (userId: string) =>
  (await loadSubject(userId))?.positions;

interface PositionBody {
  position: { id: string; key: string; name: string; holderCount: number };
  holderCount?: number;
  assigned?: string[];
}

const as = <T>(body: unknown) => body as T;

describe("a position's life", () => {
  it("runs create, assign, rename, delete and retired-key reuse in order", async () => {
    const key = `lifecycle-${Math.random().toString(36).slice(2, 10)}`;
    const admin = await createAdmin({ twoFactorEnabled: true });
    const actor = await signIn(admin);
    const [u1, u2] = [await createUser(), await createUser()];
    const holders = [u1.id, u2.id].sort();
    const tracker = auditTracker(() => [admin.id]);
    const url = (id: string) => `${API}/positions/${id}`;

    // 1. Create.
    const created = await callRoute(createPosition, {
      method: "POST",
      url: `${API}/positions`,
      as: actor,
      body: { key, name: "Lifecycle Role" },
    });
    expect(created.status).toBe(201);
    const { id } = as<PositionBody>(created.body).position;
    expect(as<PositionBody>(created.body).position).toMatchObject({
      key,
      name: "Lifecycle Role",
      holderCount: 0,
    });
    const createdRows = await tracker.fresh();
    expect(createdRows.map((row) => row.type)).toEqual(["POSITION_CREATED"]);
    expect(createdRows[0]).toMatchObject({
      targetId: id,
      actorUserId: admin.id,
    });

    // 2. Assign two holders.
    const assigned = await callRoute(assignHolders, {
      method: "POST",
      url: `${url(id)}/holders`,
      as: actor,
      body: { userIds: holders },
      params: { id },
    });
    expect(assigned.status).toBe(200);
    expect(as<PositionBody>(assigned.body).assigned).toEqual(holders);
    const assignedRows = await tracker.fresh();
    expect(assignedRows.map((row) => row.type)).toEqual([
      "POSITION_ASSIGNED",
      "POSITION_ASSIGNED",
    ]);
    expect(assignedRows.map((row) => row.targetId).sort()).toEqual(holders);
    expect(await sessionPositions(u1.id)).toEqual([
      expect.objectContaining({ key, name: "Lifecycle Role" }),
    ]);

    // 3. Rename: the name changes, the key and the holders do not.
    const beforeRename = [
      await sessionPositions(u1.id),
      await sessionPositions(u2.id),
    ];
    const renamed = await callRoute(patchPosition, {
      method: "PATCH",
      url: url(id),
      as: actor,
      body: { name: "Renamed Role" },
      params: { id },
    });
    expect(renamed.status).toBe(200);
    expect(as<PositionBody>(renamed.body).position).toMatchObject({
      key,
      name: "Renamed Role",
      holderCount: 2,
    });
    expect(await prisma.userPosition.count({ where: { positionId: id } })).toBe(
      2,
    );
    expect([
      await sessionPositions(u1.id),
      await sessionPositions(u2.id),
    ]).toEqual(
      beforeRename.map((positions) =>
        positions?.map((position) => ({ ...position, name: "Renamed Role" })),
      ),
    );
    expect((await tracker.fresh()).map((row) => row.type)).toEqual([
      "POSITION_UPDATED",
    ]);

    // 4. Delete needs the key typed exactly.
    const wrong = await callRoute(deletePosition, {
      method: "DELETE",
      url: url(id),
      as: actor,
      body: { confirmKey: key.toUpperCase() },
      params: { id },
    });
    expect(wrong.status).toBe(400);
    expect(codeOf(wrong.body)).toBe("CONFIRM_KEY_MISMATCH");
    expect(
      (await prisma.position.findUniqueOrThrow({ where: { id } })).deletedAt,
    ).toBeNull();
    expect(await tracker.fresh()).toEqual([]);

    const deleted = await callRoute(deletePosition, {
      method: "DELETE",
      url: url(id),
      as: actor,
      body: { confirmKey: key },
      params: { id },
    });
    expect(deleted.status).toBe(200);
    expect(as<PositionBody>(deleted.body).holderCount).toBe(2);
    expect(await sessionPositions(u1.id)).toEqual([]);
    expect(await sessionPositions(u2.id)).toEqual([]);
    expect(await prisma.userPosition.count({ where: { positionId: id } })).toBe(
      2,
    );
    const deletedRows = await tracker.fresh();
    expect(deletedRows.map((row) => row.type)).toEqual(["POSITION_DELETED"]);
    expect(deletedRows[0]?.metadata).toMatchObject({ holderIds: holders });

    // 5. A deleted position takes no new holders, by either route.
    const viaHolders = await callRoute(assignHolders, {
      method: "POST",
      url: `${url(id)}/holders`,
      as: actor,
      body: { userIds: [u1.id] },
      params: { id },
    });
    const viaUser = await callRoute(assignToUser, {
      method: "PATCH",
      url: `${API}/users/${u1.id}/positions`,
      as: actor,
      body: { assign: [id] },
      params: { id: u1.id },
    });
    for (const refused of [viaHolders, viaUser]) {
      expect(refused.status).toBe(409);
      expect(codeOf(refused.body)).toBe("POSITION_DELETED");
    }
    expect(await prisma.userPosition.count({ where: { positionId: id } })).toBe(
      2,
    );
    expect(await tracker.fresh()).toEqual([]);

    // 6. The key is retired.
    const reuse = () =>
      callRoute(createPosition, {
        method: "POST",
        url: `${API}/positions`,
        as: actor,
        body: { key, name: "Second Life" },
      });
    const retired = await reuse();
    expect(retired.status).toBe(409);
    expect(codeOf(retired.body)).toBe("KEY_RETIRED");

    // 7. The retirement lasts 365 days.
    const retireAt = (daysAgo: number) =>
      prisma.retiredPositionKey.update({
        where: { positionId: id },
        data: { retiredAt: new Date(Date.now() - daysAgo * DAY_MS) },
      });
    await retireAt(364);
    expect((await reuse()).status).toBe(409);

    await retireAt(366);
    const reborn = await reuse();
    expect(reborn.status).toBe(201);
    const newId = as<PositionBody>(reborn.body).position.id;
    expect(newId).not.toBe(id);
    // Reusing the key does not bring the old holders back.
    expect(
      await prisma.userPosition.count({ where: { positionId: newId } }),
    ).toBe(0);
    expect(await sessionPositions(u1.id)).toEqual([]);
    expect(await sessionPositions(u2.id)).toEqual([]);

    // 8. The first position's trail, oldest first.
    const trail = await prisma.auditEvent.findMany({
      where: {
        OR: [
          { targetType: "POSITION", targetId: id },
          {
            type: "POSITION_ASSIGNED",
            metadata: { path: ["positionId"], equals: id },
          },
        ],
      },
      orderBy: { createdAt: "asc" },
    });
    expect(trail.map((row) => row.type)).toEqual([
      "POSITION_CREATED",
      "POSITION_ASSIGNED",
      "POSITION_ASSIGNED",
      "POSITION_UPDATED",
      "POSITION_DELETED",
    ]);
  }, 60_000);
});
