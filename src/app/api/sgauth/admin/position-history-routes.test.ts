import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  getPositionHistory: vi.fn(),
  getUserPositionHistory: vi.fn(),
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
vi.mock("@/lib/position-history", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/position-history")>()),
  getPositionHistory: mocks.getPositionHistory,
  getUserPositionHistory: mocks.getUserPositionHistory,
}));

import { GET as getPosition } from "./positions/[id]/history/route";
import { GET as getUser } from "./users/[id]/position-history/route";

const ID = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7b";
const PAGE = { events: [], nextCursor: null };

const request = (query = "") =>
  new NextRequest(`http://localhost:3000/api/sgauth/admin/x${query}`);
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const routes = [
  {
    name: "positions/[id]/history",
    call: (id: string, query?: string) => getPosition(request(query), ctx(id)),
    lib: mocks.getPositionHistory,
    notFound: {
      code: "POSITION_NOT_FOUND",
      message: "Position not found.",
    },
  },
  {
    name: "users/[id]/position-history",
    call: (id: string, query?: string) => getUser(request(query), ctx(id)),
    lib: mocks.getUserPositionHistory,
    notFound: { code: "USER_NOT_FOUND", message: "User not found." },
  },
];

const INVALID = {
  code: "INVALID_INPUT",
  message: "Invalid request parameters.",
};

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actor: { id: "admin" } });
});

describe.each(routes)("GET $name", ({ call, lib, notFound }) => {
  it("passes the guard's denial through unchanged", async () => {
    const denial = Response.json({ code: "FORBIDDEN" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ response: denial });
    expect(await call(ID)).toBe(denial);
    expect(lib).not.toHaveBeenCalled();
  });

  it("runs the non-mutating admin guard", async () => {
    lib.mockResolvedValue(PAGE);
    await call(ID);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({ mutation: false });
  });

  it.each([
    ["a non-uuid id", "not-a-uuid", ""],
    ["limit=500", ID, "?limit=500"],
    ["a malformed cursor", ID, "?cursor=%25%25"],
  ])("answers 400 with the flat body for %s", async (_name, id, query) => {
    const res = await call(id, query);
    expect(res.status).toBe(400);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    const body = await res.json();
    expect(body).toStrictEqual(INVALID);
    expect(body).not.toHaveProperty("error");
    expect(lib).not.toHaveBeenCalled();
  });

  it("answers 404 with the flat body when the library finds nothing", async () => {
    lib.mockResolvedValue(null);
    const res = await call(ID);
    expect(res.status).toBe(404);
    const body = await res.json();
    expect(body).toStrictEqual(notFound);
    expect(body).not.toHaveProperty("error");
  });

  it("answers 200 with the page, uncached, and passes the parsed query on", async () => {
    lib.mockResolvedValue(PAGE);
    const res = await call(ID, "?limit=7");
    expect(res.status).toBe(200);
    expect(res.headers.get("Cache-Control")).toBe("no-store");
    expect(await res.json()).toEqual(PAGE);
    expect(lib).toHaveBeenCalledWith({}, ID, { limit: 7 });
  });
});
