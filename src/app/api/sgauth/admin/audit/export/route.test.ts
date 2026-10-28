import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  limitRequest: vi.fn(),
  audit: vi.fn(),
  buildAuditWhere: vi.fn(),
  resolveUserFilter: vi.fn(),
  exportAuditCsv: vi.fn(),
  loggerError: vi.fn(),
}));

vi.mock("@/lib/prisma", () => ({ prisma: { tag: "prisma" } }));
vi.mock("@/lib/auth/server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/admin-api", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/admin-api")>()),
  requireAdmin: mocks.requireAdmin,
}));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: mocks.limitRequest,
}));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));
vi.mock("@/lib/log", () => ({ logger: { error: mocks.loggerError } }));
vi.mock("@/lib/log/request", () => ({
  withRequestLogging:
    (_route: string, handler: (req: Request) => Promise<Response>) =>
    (req: Request) =>
      handler(req),
}));
vi.mock("@/lib/audit-log", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/audit-log")>()),
  buildAuditWhere: mocks.buildAuditWhere,
  resolveUserFilter: mocks.resolveUserFilter,
  exportAuditCsv: mocks.exportAuditCsv,
}));

import { GET } from "./route";

const ADMIN = { id: "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7b" };
const USER = "0192ab3c-4d5e-7f60-8a1b-2c3d4e5f6a7c";

const get = (query = "") =>
  GET(
    new Request(`http://localhost:3000/api/sgauth/admin/audit/export${query}`),
  );

async function* csv(...chunks: string[]) {
  for (const chunk of chunks) yield chunk;
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actor: ADMIN });
  mocks.limitRequest.mockResolvedValue(null);
  mocks.audit.mockResolvedValue(undefined);
  mocks.buildAuditWhere.mockReturnValue({ AND: [] });
  mocks.resolveUserFilter.mockResolvedValue(null);
  mocks.exportAuditCsv.mockImplementation(() => csv("﻿id\r\n", "row\r\n"));
});

describe("GET /api/sgauth/admin/audit/export", () => {
  it("passes a guard denial through and does nothing else", async () => {
    const denied = Response.json({ code: "NOT_ADMIN" }, { status: 403 });
    mocks.requireAdmin.mockResolvedValue({ response: denied });

    expect(await get()).toBe(denied);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      mutation: false,
      action: "accessAdmin",
    });
    expect(mocks.limitRequest).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("passes a 429 through without auditing", async () => {
    const limited = Response.json(
      { code: "TOO_MANY_REQUESTS" },
      { status: 429 },
    );
    mocks.limitRequest.mockResolvedValue(limited);

    expect(await get()).toBe(limited);
    expect(mocks.limitRequest).toHaveBeenCalledWith("adminExport", ADMIN.id);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("answers 400 INVALID_INPUT for a bad filter without auditing", async () => {
    const response = await get("?type=NOPE");

    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({
      code: "INVALID_INPUT",
      message: "Invalid filter.",
    });
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails closed: no stream when the audit write fails", async () => {
    mocks.audit.mockRejectedValue(new Error("db down"));

    await expect(get()).rejects.toThrow("db down");
    expect(mocks.exportAuditCsv).not.toHaveBeenCalled();
  });

  it("exports the header only for an email that matches no user", async () => {
    await get("?user=nobody@northeastern.edu");

    expect(mocks.resolveUserFilter).toHaveBeenCalledWith(
      { tag: "prisma" },
      "nobody@northeastern.edu",
    );
    expect(mocks.buildAuditWhere.mock.calls[0][1]).toBeNull();
  });

  it("streams the CSV and audits the export once", async () => {
    mocks.resolveUserFilter.mockResolvedValue({ id: USER, found: true });

    const response = await get(
      `?type=LOGOUT&type=LOGIN_SUCCESS&user=${USER}&userRole=actor&from=2026-10-01&cursor=ignored`,
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("Content-Type")).toBe(
      "text/csv; charset=utf-8",
    );
    expect(response.headers.get("Content-Disposition")).toMatch(
      /^attachment; filename="sgauth-audit-\d{8}-\d{4}\.csv"$/,
    );
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    // `text()` drops a leading BOM, so read the bytes.
    const bytes = new Uint8Array(await response.arrayBuffer());
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(new TextDecoder("utf-8", { ignoreBOM: true }).decode(bytes)).toBe(
      "﻿id\r\nrow\r\n",
    );

    expect(mocks.audit).toHaveBeenCalledTimes(1);
    expect(mocks.audit.mock.calls[0][0]).toEqual({
      type: "AUDIT_EXPORTED",
      actorType: "USER",
      actorUserId: ADMIN.id,
    });
    // The query string, parsed once, is what the where builder gets.
    expect(mocks.buildAuditWhere).toHaveBeenCalledWith(
      {
        type: ["LOGOUT", "LOGIN_SUCCESS"],
        user: USER,
        userRole: "actor",
        from: "2026-10-01",
      },
      USER,
    );
    expect(mocks.exportAuditCsv).toHaveBeenCalledWith(
      { tag: "prisma" },
      { AND: [] },
    );
  });

  it("errors the stream without logging the cause when a batch fails", async () => {
    mocks.exportAuditCsv.mockImplementation(async function* () {
      yield "header\r\n";
      throw new Error("secret@northeastern.edu");
    });

    const response = await get();
    await expect(response.text()).rejects.toThrow("Audit export failed");
    expect(mocks.loggerError).toHaveBeenCalledWith("Audit export failed", {
      chunksSent: 1,
    });
  });
});
