import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  // Set to a call number to make that audit() call throw; null passes through.
  failAuditOnCall: null as number | null,
  auditCalls: 0,
}));

vi.mock("@/lib/auth/server", () => ({ getSession: mocks.getSession }));
// Outside a Next request scope audit() cannot read the request headers, so
// supply the ones request() sends.
vi.mock("next/headers", () => ({
  headers: async () => new Headers({ "x-real-ip": "203.0.113.7" }),
}));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: async () => null,
}));
vi.mock("@/lib/audit", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/audit")>();
  return {
    ...actual,
    audit: ((...args: Parameters<typeof actual.audit>) => {
      mocks.auditCalls += 1;
      if (mocks.auditCalls === mocks.failAuditOnCall) {
        throw new Error("audit failed");
      }
      return actual.audit(...args);
    }) as typeof actual.audit,
  };
});

import { toPositionError } from "@/lib/positions";
import { prisma } from "@/lib/prisma";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";
import { assignPositionToUsers } from "@/lib/position-assignments";
import { can } from "@/lib/authz";
import {
  createAdmin,
  createPosition,
  createPrimaryAdmin,
  createUser,
} from "@/test/factories";
import { PATCH } from "./users/[id]/positions/route";
import { POST } from "./positions/[id]/holders/route";

const BASE = "http://localhost:3000/api/sgauth/admin";
const IP = "203.0.113.7";

function request(method: string, url: string, body: unknown) {
  return new NextRequest(url, {
    method,
    body: JSON.stringify(body),
    headers: { "content-type": "application/json", "x-real-ip": IP },
  });
}

const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const patchUser = (userId: string, body: unknown) =>
  PATCH(
    request("PATCH", `${BASE}/users/${userId}/positions`, body),
    ctx(userId),
  );
const postHolders = (positionId: string, userIds: string[]) =>
  POST(
    request("POST", `${BASE}/positions/${positionId}/holders`, { userIds }),
    ctx(positionId),
  );

function signInAs(user: { id: string }) {
  mocks.getSession.mockResolvedValue({ user: { id: user.id } });
}

async function users(count: number) {
  return Promise.all(Array.from({ length: count }, () => createUser()));
}

async function positions(count: number) {
  const created = [];
  for (let i = 0; i < count; i += 1) created.push(await createPosition());
  return created;
}

async function hold(userId: string, positionIds: string[]) {
  await prisma.userPosition.createMany({
    data: positionIds.map((positionId) => ({ userId, positionId })),
  });
}

const heldCount = (userId: string) =>
  prisma.userPosition.count({ where: { userId } });

function assignedRows(positionId: string) {
  return prisma.auditEvent.findMany({
    where: {
      type: "POSITION_ASSIGNED",
      metadata: { path: ["positionId"], equals: positionId },
    },
  });
}

function userRows(userId: string, type: string) {
  return prisma.auditEvent.findMany({
    where: { type: type as "POSITION_ASSIGNED", targetId: userId },
  });
}

let admin: Awaited<ReturnType<typeof createAdmin>>;

beforeEach(async () => {
  mocks.getSession.mockReset();
  mocks.failAuditOnCall = null;
  mocks.auditCalls = 0;
  admin = await createAdmin({ twoFactorEnabled: true });
  signInAs(admin);
});

describe("admin MFA", () => {
  it("refuses an admin without MFA on both routes, then accepts them once enrolled", async () => {
    const unenrolled = await createAdmin({ twoFactorEnabled: false });
    signInAs(unenrolled);
    const [user] = await users(1);
    const [position] = await positions(1);

    const patch = await patchUser(user.id, { assign: [position.id] });
    expect(patch.status).toBe(403);
    expect(await patch.json()).toMatchObject({
      code: "MFA_REQUIRED",
      enrollmentUrl: "/account/security",
    });
    const post = await postHolders(position.id, [user.id]);
    expect(post.status).toBe(403);
    expect(await post.json()).toMatchObject({ code: "MFA_REQUIRED" });
    expect(await heldCount(user.id)).toBe(0);
    expect(await userRows(user.id, "POSITION_ASSIGNED")).toHaveLength(0);

    await prisma.user.update({
      where: { id: unenrolled.id },
      data: { twoFactorEnabled: true },
    });
    expect((await patchUser(user.id, { assign: [position.id] })).status).toBe(
      200,
    );
  });
});

describe("the position cap (AC 1)", () => {
  it("refuses a 51st position with POSITION_LIMIT and writes nothing", async () => {
    const [user] = await users(1);
    const held = await positions(MAX_ACTIVE_POSITIONS_PER_USER);
    await hold(
      user.id,
      held.map((p) => p.id),
    );
    const [extra] = await positions(1);

    const response = await patchUser(user.id, { assign: [extra.id] });
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "POSITION_LIMIT",
      userIds: [user.id],
    });
    expect(await heldCount(user.id)).toBe(MAX_ACTIVE_POSITIONS_PER_USER);
    expect(await userRows(user.id, "POSITION_ASSIGNED")).toHaveLength(0);
  });

  it("maps the trigger's rejection to POSITION_LIMIT", async () => {
    const [user] = await users(1);
    const held = await positions(MAX_ACTIVE_POSITIONS_PER_USER);
    await hold(
      user.id,
      held.map((p) => p.id),
    );
    const [extra] = await positions(1);

    const error = await prisma
      .$transaction(async (tx) => {
        await tx.userPosition.create({
          data: { userId: user.id, positionId: extra.id },
        });
        throw new Error("unreachable: the trigger should have rejected");
      })
      .catch((err: unknown) => err);
    expect(toPositionError(error)?.code).toBe("POSITION_LIMIT");
  });

  it("lets a swap at the cap succeed", async () => {
    const [user] = await users(1);
    const held = await positions(MAX_ACTIVE_POSITIONS_PER_USER);
    await hold(
      user.id,
      held.map((p) => p.id),
    );
    const [incoming] = await positions(1);

    const response = await patchUser(user.id, {
      unassign: [held[0].id],
      assign: [incoming.id],
    });
    expect(response.status).toBe(200);
    expect(await heldCount(user.id)).toBe(MAX_ACTIVE_POSITIONS_PER_USER);
    expect(await userRows(user.id, "POSITION_UNASSIGNED")).toHaveLength(1);
    expect(await userRows(user.id, "POSITION_ASSIGNED")).toHaveLength(1);
  });
});

describe("bulk assign (AC 2)", () => {
  it("assigns 30 users in one call with one audit row per pair", async () => {
    const [position] = await positions(1);
    const targets = await users(30);

    const response = await postHolders(
      position.id,
      targets.map((u) => u.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assigned).toHaveLength(30);
    expect(body.alreadyHeld).toEqual([]);

    const rows = await assignedRows(position.id);
    expect(rows).toHaveLength(30);
    expect(new Set(rows.map((r) => r.targetId))).toEqual(
      new Set(targets.map((u) => u.id)),
    );
    for (const row of rows) {
      expect(row.actorUserId).toBe(admin.id);
      expect(row.ip).toBe(IP);
    }
  });

  it("writes nothing for the other 29 when one user is at the cap", async () => {
    const [position] = await positions(1);
    const targets = await users(30);
    const held = await positions(MAX_ACTIVE_POSITIONS_PER_USER);
    await hold(
      targets[0].id,
      held.map((p) => p.id),
    );

    const response = await postHolders(
      position.id,
      targets.map((u) => u.id),
    );
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "POSITION_LIMIT",
      userIds: [targets[0].id],
    });
    expect(
      await prisma.userPosition.count({ where: { positionId: position.id } }),
    ).toBe(0);
    expect(await assignedRows(position.id)).toHaveLength(0);
  });

  it("rolls everything back when the 30th audit write fails", async () => {
    const [position] = await positions(1);
    const targets = await users(30);
    mocks.failAuditOnCall = 30;

    await expect(
      postHolders(
        position.id,
        targets.map((u) => u.id),
      ),
    ).rejects.toThrow("audit failed");
    expect(
      await prisma.userPosition.count({ where: { positionId: position.id } }),
    ).toBe(0);
    expect(await assignedRows(position.id)).toHaveLength(0);
  });

  it("ignores duplicates and audits only the new pairs", async () => {
    const [position] = await positions(1);
    const first = await users(30);
    const extra = await users(5);
    await postHolders(
      position.id,
      first.map((u) => u.id),
    );

    const response = await postHolders(
      position.id,
      [...first, ...extra].map((u) => u.id),
    );
    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.assigned).toHaveLength(5);
    expect(body.alreadyHeld).toHaveLength(30);
    expect(await assignedRows(position.id)).toHaveLength(35);
  });
});

describe("unassigning", () => {
  it("ignores a position the user does not hold and writes no audit row", async () => {
    const [user] = await users(1);
    const [position] = await positions(1);
    const response = await patchUser(user.id, { unassign: [position.id] });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ unassigned: [] });
    expect(await userRows(user.id, "POSITION_UNASSIGNED")).toHaveLength(0);
  });

  it("returns the user's active positions after the change", async () => {
    const [user] = await users(1);
    const [a, b] = await positions(2);
    const response = await patchUser(user.id, { assign: [a.id, b.id] });
    const body = await response.json();
    expect(body.positions.map((p: { id: string }) => p.id).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(body.positions[0]).toHaveProperty("key");
  });
});

describe("unknown and deleted rows", () => {
  it("refuses a soft-deleted position in either list", async () => {
    const [user] = await users(1);
    const deleted = await createPosition({ deletedAt: new Date() });

    for (const body of [{ assign: [deleted.id] }, { unassign: [deleted.id] }]) {
      const response = await patchUser(user.id, body);
      expect(response.status).toBe(409);
      expect(await response.json()).toMatchObject({
        code: "POSITION_DELETED",
        positionIds: [deleted.id],
      });
    }
    const bulk = await postHolders(deleted.id, [user.id]);
    expect(bulk.status).toBe(409);
    expect(await bulk.json()).toMatchObject({ code: "POSITION_DELETED" });
  });

  it("answers 404 for an unknown position or user", async () => {
    const [user] = await users(1);
    const [position] = await positions(1);
    const unknown = "0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e";

    const noPosition = await patchUser(user.id, { assign: [unknown] });
    expect(noPosition.status).toBe(404);
    expect(await noPosition.json()).toMatchObject({
      code: "POSITION_NOT_FOUND",
      positionIds: [unknown],
    });

    const noUser = await postHolders(position.id, [user.id, unknown]);
    expect(noUser.status).toBe(404);
    expect(await noUser.json()).toMatchObject({
      code: "USER_NOT_FOUND",
      userIds: [unknown],
    });
  });

  it("refuses a DELETED user and accepts a DEACTIVATED one", async () => {
    const [position] = await positions(1);
    const deleted = await createUser({ status: "DELETED" });
    const deactivated = await createUser({ status: "DEACTIVATED" });

    const refused = await postHolders(position.id, [deleted.id]);
    expect(refused.status).toBe(409);
    expect(await refused.json()).toMatchObject({
      code: "USER_DELETED",
      userIds: [deleted.id],
    });

    const accepted = await postHolders(position.id, [deactivated.id]);
    expect(accepted.status).toBe(200);
    expect(await heldCount(deactivated.id)).toBe(1);
  });
});

describe("refused actors", () => {
  it("refuses a non-admin and a deactivated admin and writes nothing", async () => {
    const [user] = await users(1);
    const [position] = await positions(1);

    signInAs(await createUser({ twoFactorEnabled: true }));
    const nonAdmin = await patchUser(user.id, { assign: [position.id] });
    expect(nonAdmin.status).toBe(403);
    expect(await nonAdmin.json()).toMatchObject({ code: "NOT_ADMIN" });

    signInAs(
      await createAdmin({ twoFactorEnabled: true, status: "DEACTIVATED" }),
    );
    const inactive = await postHolders(position.id, [user.id]);
    expect(inactive.status).toBe(403);
    expect(await inactive.json()).toMatchObject({ code: "ACTOR_INACTIVE" });

    expect(await heldCount(user.id)).toBe(0);
  });
});

describe("self and Primary Admin targets", () => {
  it("lets the actor assign themselves a position, audited", async () => {
    const [position] = await positions(1);
    const response = await patchUser(admin.id, { assign: [position.id] });
    expect(response.status).toBe(200);
    expect(await userRows(admin.id, "POSITION_ASSIGNED")).toHaveLength(1);
  });

  it("assigns the Primary Admin a position like any other user", async () => {
    const [position] = await positions(1);
    class Rollback extends Error {}
    await prisma
      .$transaction(async (tx) => {
        const pa = await createPrimaryAdmin({}, tx);
        const result = await assignPositionToUsers(tx, {
          actorId: admin.id,
          positionId: position.id,
          userIds: [pa.id],
          authorize: (target) => can(admin, "assignPosition", target),
        });
        expect(result).toEqual({ assigned: [pa.id], alreadyHeld: [] });
        throw new Rollback();
      })
      .catch((err: unknown) => {
        if (!(err instanceof Rollback)) throw err;
      });
  });
});
