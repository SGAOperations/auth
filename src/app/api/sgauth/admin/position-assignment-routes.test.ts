import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  can: vi.fn(),
  audit: vi.fn(),
  updateUserPositions: vi.fn(),
  assignPositionToUsers: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/rate-limit/server", () => ({ limitRequest: vi.fn() }));
vi.mock("@/lib/admin-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/admin-api")>()),
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/log", () => ({ logger: {} }));
vi.mock("@/lib/log/request", () => ({
  withRequestLogging:
    (_route: string, handler: (req: Request) => Promise<Response>) =>
    (req: Request) =>
      handler(req),
}));
vi.mock("@/lib/authz", () => ({ can: mocks.can }));
vi.mock("@/lib/audit", () => ({
  audit: mocks.audit,
  withAuditTransaction: (
    client: { $transaction?: unknown },
    fn: (tx: unknown) => unknown,
  ) => fn({ client }),
}));
vi.mock("@/lib/position-assignments", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/position-assignments")>()),
  updateUserPositions: mocks.updateUserPositions,
  assignPositionToUsers: mocks.assignPositionToUsers,
}));

import { PATCH } from "./users/[id]/positions/route";
import { POST } from "./positions/[id]/holders/route";
import { AssignmentError } from "@/lib/position-assignments";

const ACTOR = {
  id: "00000000-0000-4000-8000-0000000000aa",
  isAdmin: true,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  twoFactorEnabled: true,
};
const USER = "00000000-0000-4000-8000-000000000001";
const P1 = "00000000-0000-4000-8000-0000000000b1";
const P2 = "00000000-0000-4000-8000-0000000000b2";
const TARGET = {
  id: USER,
  isAdmin: false,
  isPrimaryAdmin: false,
  status: "ACTIVE",
};

const json = (method: string, body: unknown) =>
  new NextRequest("http://localhost:3000/api/sgauth/admin/x", {
    method,
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const routes = [
  {
    name: "PATCH users/[id]/positions",
    id: USER,
    body: { assign: [P1] },
    call: (req: NextRequest, id: string) => PATCH(req, ctx(id)),
    method: "PATCH",
  },
  {
    name: "POST positions/[id]/holders",
    id: P1,
    body: { userIds: [USER] },
    call: (req: NextRequest, id: string) => POST(req, ctx(id)),
    method: "POST",
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actor: ACTOR });
  mocks.can.mockReturnValue({ allowed: true });
  mocks.updateUserPositions.mockResolvedValue({
    assigned: [P1],
    unassigned: [],
    positions: [],
  });
  mocks.assignPositionToUsers.mockResolvedValue({
    assigned: [USER],
    alreadyHeld: [],
  });
});

describe.each(routes)("$name", ({ id, body, call, method }) => {
  it("keeps the guard's default MFA requirement", async () => {
    await call(json(method, body), id);
    expect(mocks.requireAdmin).toHaveBeenCalledTimes(1);
    const options = mocks.requireAdmin.mock.calls[0]?.[0];
    expect(options).toMatchObject({ mutation: true });
    expect(options).not.toHaveProperty("requireMfa", false);
  });

  it.each([
    [401, { code: "UNAUTHENTICATED" }],
    [403, { code: "NOT_ADMIN" }],
    [403, { code: "MFA_REQUIRED", enrollmentUrl: "/account/security" }],
    [429, { code: "TOO_MANY_REQUESTS" }],
  ])(
    "passes the guard's %i refusal through untouched",
    async (status, payload) => {
      mocks.requireAdmin.mockResolvedValue({
        response: Response.json(payload, { status }),
      });
      const response = await call(json(method, body), id);
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(payload);
      expect(mocks.updateUserPositions).not.toHaveBeenCalled();
      expect(mocks.assignPositionToUsers).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["a non-uuid path id", "not-a-uuid", body],
    ["a malformed body", id, "{not json"],
    ["a schema failure", id, { extra: true }],
  ])("answers 400 INVALID_INPUT for %s", async (_label, pathId, payload) => {
    const response = await call(json(method, payload), pathId);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.updateUserPositions).not.toHaveBeenCalled();
    expect(mocks.assignPositionToUsers).not.toHaveBeenCalled();
  });

  it("maps a service error to its status", async () => {
    const error = new AssignmentError("POSITION_LIMIT", { userIds: [USER] });
    mocks.updateUserPositions.mockRejectedValue(error);
    mocks.assignPositionToUsers.mockRejectedValue(error);
    const response = await call(json(method, body), id);
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({
      code: "POSITION_LIMIT",
      userIds: [USER],
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error", async () => {
    const boom = new Error("db down");
    mocks.updateUserPositions.mockRejectedValue(boom);
    mocks.assignPositionToUsers.mockRejectedValue(boom);
    await expect(call(json(method, body), id)).rejects.toBe(boom);
  });
});

describe("PATCH users/[id]/positions", () => {
  it("authorizes by action, audits each changed pair and answers 200", async () => {
    mocks.updateUserPositions.mockResolvedValue({
      assigned: [P1],
      unassigned: [P2],
      positions: [{ id: P1, key: "k", name: "n", category: null }],
    });
    const response = await PATCH(
      json("PATCH", { assign: [P1], unassign: [P2] }),
      ctx(USER),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      userId: USER,
      assigned: [P1],
      unassigned: [P2],
    });

    const { authorize } = mocks.updateUserPositions.mock.calls[0]?.[1];
    expect(authorize(TARGET)).toEqual({ allowed: true });
    expect(mocks.can).toHaveBeenCalledWith(ACTOR, "unassignPosition", TARGET);
    expect(mocks.can).toHaveBeenCalledWith(ACTOR, "assignPosition", TARGET);

    expect(mocks.audit).toHaveBeenCalledTimes(2);
    expect(mocks.audit).toHaveBeenCalledWith({
      type: "POSITION_UNASSIGNED",
      actorType: "USER",
      actorUserId: ACTOR.id,
      targetType: "USER",
      targetId: USER,
      metadata: { positionId: P2 },
    });
    expect(mocks.audit).toHaveBeenCalledWith({
      type: "POSITION_ASSIGNED",
      actorType: "USER",
      actorUserId: ACTOR.id,
      targetType: "USER",
      targetId: USER,
      metadata: { positionId: P1 },
    });
  });

  it("checks only assignPosition when nothing is unassigned", async () => {
    await PATCH(json("PATCH", { assign: [P1] }), ctx(USER));
    const { authorize } = mocks.updateUserPositions.mock.calls[0]?.[1];
    authorize(TARGET);
    expect(mocks.can).toHaveBeenCalledTimes(1);
    expect(mocks.can).toHaveBeenCalledWith(ACTOR, "assignPosition", TARGET);
  });

  it("returns the first denial from can()", async () => {
    mocks.can.mockReturnValue({ allowed: false, reason: "NOT_ADMIN" });
    await PATCH(json("PATCH", { assign: [P1] }), ctx(USER));
    const { authorize } = mocks.updateUserPositions.mock.calls[0]?.[1];
    expect(authorize(TARGET)).toEqual({ allowed: false, reason: "NOT_ADMIN" });
  });

  it("maps FORBIDDEN to 403 with the reason", async () => {
    mocks.updateUserPositions.mockRejectedValue(
      new AssignmentError("FORBIDDEN", {
        userIds: [USER],
        reason: "PRIMARY_ADMIN_PROTECTED",
      }),
    );
    const response = await PATCH(json("PATCH", { assign: [P1] }), ctx(USER));
    expect(response.status).toBe(403);
    expect(await response.json()).toMatchObject({
      code: "FORBIDDEN",
      reason: "PRIMARY_ADMIN_PROTECTED",
      userIds: [USER],
    });
  });
});

describe("POST positions/[id]/holders", () => {
  it("authorizes assignPosition, audits each assigned user and answers 200", async () => {
    const other = "00000000-0000-4000-8000-000000000002";
    mocks.assignPositionToUsers.mockResolvedValue({
      assigned: [USER],
      alreadyHeld: [other],
    });
    const response = await POST(
      json("POST", { userIds: [USER, other] }),
      ctx(P1),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(await response.json()).toEqual({
      positionId: P1,
      assigned: [USER],
      alreadyHeld: [other],
    });

    const { authorize } = mocks.assignPositionToUsers.mock.calls[0]?.[1];
    authorize(TARGET);
    expect(mocks.can).toHaveBeenCalledWith(ACTOR, "assignPosition", TARGET);

    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit).toHaveBeenCalledWith({
      type: "POSITION_ASSIGNED",
      actorType: "USER",
      actorUserId: ACTOR.id,
      targetType: "USER",
      targetId: USER,
      metadata: { positionId: P1 },
    });
  });
});
