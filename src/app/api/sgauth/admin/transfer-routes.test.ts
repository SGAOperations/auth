import { beforeEach, describe, expect, it, vi } from "vitest";
import { NextRequest } from "next/server";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  requireFreshAuth: vi.fn(),
  initiateTransfer: vi.fn(),
  acceptTransfer: vi.fn(),
  declineTransfer: vi.fn(),
  cancelTransfer: vi.fn(),
  notifyTransfer: vi.fn(),
  loggerError: vi.fn(),
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
vi.mock("@/lib/log", () => ({ logger: { error: mocks.loggerError } }));
vi.mock("@/lib/log/request", () => ({
  withRequestLogging:
    (_route: string, handler: (req: Request) => Promise<Response>) =>
    (req: Request) =>
      handler(req),
}));
vi.mock("@/lib/audit", () => ({
  withAuditTransaction: (
    client: { $transaction?: unknown },
    fn: (tx: unknown) => unknown,
  ) => fn({ client }),
}));
vi.mock("@/lib/jobs/pa-transfer-notify", () => ({
  notifyTransfer: mocks.notifyTransfer,
}));
vi.mock("@/lib/jobs/pa-transfer-actions", async (importActual) => ({
  ...(await importActual<typeof import("@/lib/jobs/pa-transfer-actions")>()),
  initiateTransfer: mocks.initiateTransfer,
  acceptTransfer: mocks.acceptTransfer,
  declineTransfer: mocks.declineTransfer,
  cancelTransfer: mocks.cancelTransfer,
}));

import { Prisma } from "@/generated/prisma/client";
import { TransferError } from "@/lib/jobs/pa-transfer-actions";
import { POST as initiate } from "./transfer/route";
import { POST as accept } from "./transfer/[id]/accept/route";
import { POST as decline } from "./transfer/[id]/decline/route";
import { POST as cancel } from "./transfer/[id]/cancel/route";

const ACTOR = {
  id: "00000000-0000-4000-8000-0000000000aa",
  isAdmin: true,
  isPrimaryAdmin: true,
  status: "ACTIVE",
  twoFactorEnabled: true,
};
const RECIPIENT = "00000000-0000-4000-8000-000000000001";
const TRANSFER = "00000000-0000-4000-8000-0000000000b1";
const DATE = new Date("2026-11-03T12:00:00Z");

const json = (body: unknown) =>
  new NextRequest("http://localhost:3000/api/sgauth/admin/transfer", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });
const ctx = (id: string) => ({ params: Promise.resolve({ id }) });

const row = (status: string) => ({
  id: TRANSFER,
  status,
  acceptanceExpiresAt: DATE,
  executesAt: DATE,
});
const notice = {
  kind: "cancelled",
  transferId: TRANSFER,
  fromUserId: ACTOR.id,
  toUserId: RECIPIENT,
};

const initiateBody = { recipientUserId: RECIPIENT, confirmEmail: "a@b.edu" };

// The four routes through one table: how each is called, and what it needs.
const cases = [
  {
    name: "POST /transfer",
    fresh: true,
    service: mocks.initiateTransfer,
    body: initiateBody,
    pathId: TRANSFER,
    call: (req: NextRequest) => initiate(req),
    ok: { status: 201, row: row("PENDING_ACCEPTANCE") },
  },
  {
    name: "POST /transfer/[id]/accept",
    fresh: true,
    service: mocks.acceptTransfer,
    body: {},
    pathId: TRANSFER,
    call: (req: NextRequest, id: string) => accept(req, ctx(id)),
    ok: { status: 200, row: row("COOLING") },
  },
  {
    name: "POST /transfer/[id]/decline",
    fresh: false,
    service: mocks.declineTransfer,
    body: {},
    pathId: TRANSFER,
    call: (req: NextRequest, id: string) => decline(req, ctx(id)),
    ok: { status: 200, row: row("CANCELLED") },
  },
  {
    name: "POST /transfer/[id]/cancel",
    fresh: true,
    service: mocks.cancelTransfer,
    body: {},
    pathId: TRANSFER,
    call: (req: NextRequest, id: string) => cancel(req, ctx(id)),
    ok: { status: 200, row: row("CANCELLED") },
  },
];

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actor: ACTOR });
  mocks.requireFreshAuth.mockResolvedValue({ ok: true, session: {} });
  mocks.notifyTransfer.mockResolvedValue(undefined);
  for (const { service, ok } of cases) {
    service.mockResolvedValue({ transfer: ok.row, notice });
  }
});

describe.each(cases)("$name", ({ fresh, service, body, pathId, call, ok }) => {
  const run = (payload: unknown = body, id = pathId) => call(json(payload), id);

  it("keeps the guard's default MFA requirement and rate limit", async () => {
    await run();
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
      const response = await run();
      expect(response.status).toBe(status);
      expect(await response.json()).toEqual(payload);
      expect(mocks.requireFreshAuth).not.toHaveBeenCalled();
      expect(service).not.toHaveBeenCalled();
    },
  );

  if (fresh) {
    it("stops on a stale re-authentication before reading the body or touching the transfer", async () => {
      mocks.requireFreshAuth.mockResolvedValue({
        ok: false,
        response: Response.json({ code: "REAUTH_REQUIRED" }, { status: 403 }),
      });
      const response = await run("{not json");
      expect(response.status).toBe(403);
      expect(await response.json()).toEqual({ code: "REAUTH_REQUIRED" });
      expect(service).not.toHaveBeenCalled();
    });
  } else {
    it("never asks for a fresh re-authentication", async () => {
      await run();
      expect(mocks.requireFreshAuth).not.toHaveBeenCalled();
      expect(service).toHaveBeenCalledTimes(1);
    });
  }

  it.each([
    ["a malformed body", "{not json"],
    ["an unknown field", { ...body, extra: true }],
  ])("answers 400 INVALID_INPUT for %s", async (_label, payload) => {
    const response = await run(payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(service).not.toHaveBeenCalled();
  });

  it("runs the transition and answers with the committed row", async () => {
    const response = await run();
    expect(response.status).toBe(ok.status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const { transfer } = await response.json();
    expect(transfer).toMatchObject({ id: TRANSFER, status: ok.row.status });
    expect(service).toHaveBeenCalledTimes(1);
    expect(mocks.notifyTransfer).toHaveBeenCalledWith(notice);
  });

  it.each([
    ["TRANSFER_NOT_FOUND", 404],
    ["TRANSFER_INVALID_STATE", 409],
    ["TRANSFER_IN_FLIGHT", 409],
    ["CONFIRM_EMAIL_MISMATCH", 400],
    ["RECIPIENT_INELIGIBLE", 409],
    ["NOT_TRANSFER_RECIPIENT", 403],
    ["NOT_TRANSFER_INITIATOR", 403],
    ["PRIMARY_ADMIN_REQUIRED", 403],
  ] as const)(
    "maps a service %s to %i with { code, message }",
    async (code, status) => {
      service.mockRejectedValue(new TransferError(code));
      const response = await run();
      expect(response.status).toBe(status);
      expect(await response.json()).toMatchObject({
        code,
        message: expect.any(String),
      });
      expect(mocks.notifyTransfer).not.toHaveBeenCalled();
    },
  );

  it("passes the ineligibility reason through", async () => {
    service.mockRejectedValue(
      new TransferError("RECIPIENT_INELIGIBLE", "NO_MFA"),
    );
    const response = await run();
    expect(await response.json()).toMatchObject({
      code: "RECIPIENT_INELIGIBLE",
      reason: "NO_MFA",
    });
  });

  it("maps a unique-index race to 409 TRANSFER_IN_FLIGHT", async () => {
    service.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError("duplicate", {
        code: "P2002",
        clientVersion: "test",
      }),
    );
    const response = await run();
    expect(response.status).toBe(409);
    expect(await response.json()).toMatchObject({ code: "TRANSFER_IN_FLIGHT" });
  });

  it("rethrows an unexpected error", async () => {
    const boom = new Error("db down");
    service.mockRejectedValue(boom);
    await expect(run()).rejects.toBe(boom);
    expect(mocks.notifyTransfer).not.toHaveBeenCalled();
  });

  it("still succeeds when the notifier throws, and logs only ids and the kind", async () => {
    mocks.notifyTransfer.mockRejectedValue(new Error("mail down"));
    const response = await run();
    expect(response.status).toBe(ok.status);
    expect(mocks.loggerError).toHaveBeenCalledWith(
      "pa_transfer.notify_failed",
      expect.objectContaining({ transferId: TRANSFER, kind: "cancelled" }),
    );
  });
});

describe.each(cases.slice(1))("$name path id", ({ service, body, call }) => {
  it("answers 400 INVALID_INPUT for a non-uuid id", async () => {
    const response = await call(json(body), "not-a-uuid");
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "INVALID_INPUT" });
    expect(service).not.toHaveBeenCalled();
  });

  it("hands the service the id and the guarded actor's id, nothing from the body", async () => {
    await call(json(body), TRANSFER);
    expect(service.mock.calls[0]?.[1]).toEqual({
      transferId: TRANSFER,
      actorId: ACTOR.id,
    });
  });
});

describe("POST /transfer", () => {
  it("hands the service the guarded actor, the recipient and the typed email", async () => {
    await initiate(json(initiateBody));
    expect(mocks.initiateTransfer.mock.calls[0]?.[1]).toEqual({
      actor: ACTOR,
      recipientUserId: RECIPIENT,
      confirmEmail: "a@b.edu",
    });
  });

  it.each([
    ["a non-uuid recipient", { ...initiateBody, recipientUserId: "x" }],
    ["an empty confirmation", { ...initiateBody, confirmEmail: "" }],
    ["a missing confirmation", { recipientUserId: RECIPIENT }],
    [
      "an over-long confirmation",
      { ...initiateBody, confirmEmail: "a".repeat(321) },
    ],
  ])("answers 400 INVALID_INPUT for %s", async (_label, payload) => {
    const response = await initiate(json(payload));
    expect(response.status).toBe(400);
    expect(mocks.initiateTransfer).not.toHaveBeenCalled();
  });

  it("answers 201 with the id, status and acceptance deadline only", async () => {
    const response = await initiate(json(initiateBody));
    expect(response.status).toBe(201);
    expect(await response.json()).toEqual({
      transfer: {
        id: TRANSFER,
        status: "PENDING_ACCEPTANCE",
        acceptanceExpiresAt: DATE.toISOString(),
      },
    });
  });
});

describe("POST /transfer/[id]/accept", () => {
  it("answers with the id, status and execution time only", async () => {
    const response = await accept(json({}), ctx(TRANSFER));
    expect(await response.json()).toEqual({
      transfer: {
        id: TRANSFER,
        status: "COOLING",
        executesAt: DATE.toISOString(),
      },
    });
  });
});
