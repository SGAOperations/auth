import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireFreshAuth: vi.fn(),
  requestEmailChange: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/auth/server", () => ({
  getSession: vi.fn(),
  requireFreshAuth: mocks.requireFreshAuth,
}));
vi.mock("@/lib/rate-limit/server", () => ({ limitRequest: vi.fn() }));
vi.mock("@/lib/admin-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/admin-api")>()),
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn(), info: vi.fn() } }));
vi.mock("@/lib/log/request", () => ({
  withRequestLogging:
    (_route: string, handler: (req: Request) => Promise<Response>) =>
    (req: Request) =>
      handler(req),
}));
vi.mock("@/lib/email-change/server", () => ({
  emailChangeService: { requestEmailChange: mocks.requestEmailChange },
}));

import { POST } from "./route";

const ACTOR = {
  id: "00000000-0000-4000-8000-0000000000aa",
  isAdmin: true,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  twoFactorEnabled: true,
};
const TARGET = "00000000-0000-4000-8000-000000000001";
const EXPIRES = new Date("2026-11-03T12:00:00Z");

const call = (body: unknown, id = TARGET) =>
  POST(
    new NextRequest(
      `http://localhost:3000/api/sgauth/admin/users/${id}/email`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "user-agent": "vitest",
          "x-real-ip": "203.0.113.7",
        },
        body: typeof body === "string" ? body : JSON.stringify(body),
      },
    ),
    { params: Promise.resolve({ id }) },
  );

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actor: ACTOR });
  mocks.requireFreshAuth.mockResolvedValue({ ok: true, session: {} });
  mocks.requestEmailChange.mockResolvedValue({ ok: true, expiresAt: EXPIRES });
});

describe("POST /api/sgauth/admin/users/[id]/email", () => {
  it("answers 202 with the expiry and never the token", async () => {
    const response = await call({ newEmail: "  New.Person@Gmail.com " });
    expect(response.status).toBe(202);
    expect(await response.json()).toEqual({
      status: "PENDING_VERIFICATION",
      expiresAt: EXPIRES.toISOString(),
    });
    expect(mocks.requestEmailChange).toHaveBeenCalledWith({
      actor: ACTOR,
      targetId: TARGET,
      newEmail: "new.person@gmail.com",
      requestContext: { ip: "203.0.113.7", userAgent: "vitest" },
    });
  });

  it("returns the admin guard's response and does nothing else", async () => {
    mocks.requireAdmin.mockResolvedValue({
      response: Response.json({ code: "UNAUTHENTICATED" }, { status: 401 }),
    });
    const response = await call({ newEmail: "a@b.co" });
    expect(response.status).toBe(401);
    expect(mocks.requireFreshAuth).not.toHaveBeenCalled();
    expect(mocks.requestEmailChange).not.toHaveBeenCalled();
  });

  it("asks for re-authentication before it touches the target or the body", async () => {
    // A fresh Response per call: a body can be read once.
    mocks.requireFreshAuth.mockImplementation(async () => ({
      ok: false,
      response: Response.json({ code: "REAUTH_REQUIRED" }, { status: 403 }),
    }));
    for (const [body, id] of [
      [{ newEmail: "a@b.co" }, TARGET],
      ["not json", TARGET],
      [{ newEmail: "a@b.co" }, "not-a-uuid"],
    ] as const) {
      const response = await call(body, id);
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    }
    expect(mocks.requestEmailChange).not.toHaveBeenCalled();
  });

  it("answers 404 for a malformed id", async () => {
    const response = await call({ newEmail: "a@b.co" }, "not-a-uuid");
    expect(response.status).toBe(404);
    expect(await response.json()).toMatchObject({ code: "USER_NOT_FOUND" });
  });

  it.each([
    ["no body", "not json"],
    ["a missing address", {}],
    ["a malformed address", { newEmail: "nope" }],
    ["an over-long address", { newEmail: `${"a".repeat(250)}@b.co` }],
    ["an extra key", { newEmail: "a@b.co", userId: TARGET }],
  ])("answers 400 for %s", async (_name, body) => {
    const response = await call(body);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(mocks.requestEmailChange).not.toHaveBeenCalled();
  });

  it.each([
    [{ ok: false, code: "NOT_FOUND" }, 404, "USER_NOT_FOUND"],
    [{ ok: false, code: "USER_DELETED" }, 409, "USER_DELETED"],
    [{ ok: false, code: "EMAIL_UNCHANGED" }, 400, "EMAIL_UNCHANGED"],
    [{ ok: false, code: "EMAIL_UNAVAILABLE" }, 409, "EMAIL_UNAVAILABLE"],
    [{ ok: false, code: "EMAIL_SEND_LIMITED" }, 429, "EMAIL_SEND_LIMITED"],
    [
      { ok: false, code: "FORBIDDEN", reason: "PRIMARY_ADMIN_REQUIRED" },
      403,
      "PRIMARY_ADMIN_REQUIRED",
    ],
    [
      { ok: false, code: "FORBIDDEN", reason: "PRIMARY_ADMIN_PROTECTED" },
      403,
      "PRIMARY_ADMIN_PROTECTED",
    ],
  ])("maps %j to %i %s", async (result, status, code) => {
    mocks.requestEmailChange.mockResolvedValue(result);
    const response = await call({ newEmail: "a@b.co" });
    expect(response.status).toBe(status);
    const body = await response.json();
    expect(body.code).toBe(code);
    // No owner id, and nothing that hints whose address it is.
    expect(JSON.stringify(body)).not.toContain(TARGET);
  });

  it("lets an unexpected failure propagate to the route logger", async () => {
    mocks.requestEmailChange.mockRejectedValue(new Error("boom"));
    await expect(call({ newEmail: "a@b.co" })).rejects.toThrow("boom");
  });
});
