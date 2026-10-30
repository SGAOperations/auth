import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  findUnique: vi.fn(),
  limitRequest: vi.fn(),
  can: vi.fn(),
}));

// Records the call, then runs the real rule matrix.
vi.mock("@/lib/authz", async (importActual) => {
  const actual = await importActual<typeof import("@/lib/authz")>();
  return {
    ...actual,
    can: ((...args: Parameters<typeof actual.can>) => {
      mocks.can(...args);
      return (actual.can as (...a: unknown[]) => unknown)(...args);
    }) as typeof actual.can,
  };
});
vi.mock("@/lib/auth/server", () => ({ getSession: mocks.getSession }));
vi.mock("@/lib/prisma", () => ({
  prisma: { user: { findUnique: mocks.findUnique } },
}));
vi.mock("@/lib/rate-limit/server", () => ({
  limitRequest: mocks.limitRequest,
}));

import { z } from "zod";
import {
  apiError,
  positionErrorResponse,
  readJson,
  requireAdmin,
  transferErrorResponse,
} from "@/lib/admin-api";
import { MFA_ERROR_CODES } from "@/lib/auth/mfa-policy";
import type { TransferErrorCode } from "@/lib/jobs/pa-transfer-actions";
import { PositionError, type PositionErrorCode } from "@/lib/positions";

const ACTOR = {
  id: "u1",
  isAdmin: true,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  twoFactorEnabled: true,
};

function actorRow(overrides: Partial<typeof ACTOR> = {}) {
  mocks.getSession.mockResolvedValue({ user: { id: "u1" } });
  mocks.findUnique.mockResolvedValue({ ...ACTOR, ...overrides });
}

async function refusal(options: Parameters<typeof requireAdmin>[0]) {
  const result = await requireAdmin(options);
  if (!("response" in result)) throw new Error("expected a refusal");
  return {
    status: result.response.status,
    body: await result.response.json(),
    cacheControl: result.response.headers.get("cache-control"),
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  mocks.limitRequest.mockResolvedValue(null);
});

describe("requireAdmin", () => {
  it("answers 401 with no session", async () => {
    mocks.getSession.mockResolvedValue(null);
    expect(await refusal({ mutation: false })).toEqual({
      status: 401,
      body: { code: "UNAUTHENTICATED", message: "Sign in to continue." },
      cacheControl: "no-store",
    });
    expect(mocks.findUnique).not.toHaveBeenCalled();
  });

  it("answers 401 when the actor row is missing", async () => {
    mocks.getSession.mockResolvedValue({ user: { id: "gone" } });
    mocks.findUnique.mockResolvedValue(null);
    expect((await refusal({ mutation: true })).status).toBe(401);
  });

  it("answers 403 NOT_ADMIN for a non-admin", async () => {
    actorRow({ isAdmin: false });
    const { status, body } = await refusal({ mutation: false });
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "NOT_ADMIN" });
  });

  it("answers 403 ACTOR_INACTIVE for a deactivated admin", async () => {
    actorRow({ status: "DEACTIVATED" });
    const { status, body } = await refusal({ mutation: false });
    expect(status).toBe(403);
    expect(body).toMatchObject({ code: "ACTOR_INACTIVE" });
  });

  it.each([false, true])(
    "answers 403 MFA_REQUIRED by default for an admin without MFA (mutation: %s)",
    async (mutation) => {
      actorRow({ twoFactorEnabled: false });
      const { status, body } = await refusal({ mutation });
      expect(status).toBe(403);
      expect(body).toEqual({
        code: "MFA_REQUIRED",
        message: MFA_ERROR_CODES.MFA_REQUIRED.message,
        enrollmentUrl: "/account/security",
      });
      expect(mocks.limitRequest).not.toHaveBeenCalled();
    },
  );

  it("gives a non-admin without MFA the authorization reason, not MFA_REQUIRED", async () => {
    actorRow({ isAdmin: false, twoFactorEnabled: false });
    const { body } = await refusal({ mutation: false });
    expect(body).toMatchObject({ code: "NOT_ADMIN" });
    expect(body).not.toHaveProperty("enrollmentUrl");
  });

  it("lets an admin with MFA through", async () => {
    actorRow();
    const result = await requireAdmin({ mutation: false });
    expect(result).toEqual({ actor: ACTOR });
  });

  it("lets an admin without MFA through when requireMfa is false", async () => {
    actorRow({ twoFactorEnabled: false });
    const result = await requireAdmin({ mutation: false, requireMfa: false });
    expect(result).toMatchObject({ actor: { twoFactorEnabled: false } });
  });

  it("gates on managePositions unless the caller names an action", async () => {
    actorRow();
    await requireAdmin({ mutation: false });
    expect(mocks.can).toHaveBeenLastCalledWith(ACTOR, "managePositions");
    await requireAdmin({ mutation: false, action: "accessAdmin" });
    expect(mocks.can).toHaveBeenLastCalledWith(ACTOR, "accessAdmin");
  });

  it("returns the limiter's 429 for a mutation", async () => {
    actorRow();
    mocks.limitRequest.mockResolvedValue(
      Response.json({ code: "TOO_MANY_REQUESTS" }, { status: 429 }),
    );
    expect((await refusal({ mutation: true })).status).toBe(429);
    expect(mocks.limitRequest).toHaveBeenCalledWith("adminMutation", "u1");
  });

  it("does not call the limiter for a read", async () => {
    actorRow();
    await requireAdmin({ mutation: false });
    expect(mocks.limitRequest).not.toHaveBeenCalled();
  });
});

describe("apiError", () => {
  it("keeps code and message when extra names them", async () => {
    const response = apiError(403, "A", "message", {
      code: "B",
      message: "other",
      enrollmentUrl: "/x",
    });
    expect(await response.json()).toEqual({
      code: "A",
      message: "message",
      enrollmentUrl: "/x",
    });
  });
});

describe("readJson", () => {
  const schema = z.strictObject({ a: z.string() });
  const post = (body: string) =>
    new Request("http://x", { method: "POST", body });

  it("returns the parsed body", async () => {
    expect(await readJson(post('{"a":"b"}'), schema)).toEqual({
      data: { a: "b" },
    });
  });

  it.each([["not json"], ["{}"], ['{"a":"b","c":1}'], [""]])(
    "answers 400 INVALID_INPUT for %j",
    async (body) => {
      const result = await readJson(post(body), schema);
      if (!("response" in result)) throw new Error("expected a refusal");
      expect(result.response.status).toBe(400);
      expect(await result.response.json()).toMatchObject({
        code: "INVALID_INPUT",
      });
    },
  );

  async function issues(body: string) {
    const result = await readJson(post(body), schema);
    if (!("response" in result)) throw new Error("expected a refusal");
    return ((await result.response.json()) as { issues: unknown }).issues;
  }

  it("names the failing path and never echoes the input value", async () => {
    const found = await issues('{"a":42,"b":"secret-value"}');
    expect(JSON.stringify(found)).not.toContain("secret-value");
    expect(found).toEqual(
      expect.arrayContaining([{ path: "a", message: expect.any(String) }]),
    );
  });

  it("gives no issues for a body that is not JSON", async () => {
    expect(await issues("not json")).toEqual([]);
  });
});

describe("transferErrorResponse", () => {
  const expected: Record<TransferErrorCode, number> = {
    TRANSFER_NOT_FOUND: 404,
    TRANSFER_INVALID_STATE: 409,
    TRANSFER_IN_FLIGHT: 409,
    CONFIRM_EMAIL_MISMATCH: 400,
    RECIPIENT_INELIGIBLE: 409,
  };

  it.each(Object.entries(expected))("maps %s to %i", async (code, status) => {
    const response = transferErrorResponse({
      code: code as TransferErrorCode,
    });
    expect(response.status).toBe(status);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const body = await response.json();
    expect(body).toMatchObject({ code });
    expect(body).not.toHaveProperty("reason");
  });

  it("passes the ineligibility reason through", async () => {
    const response = transferErrorResponse({
      code: "RECIPIENT_INELIGIBLE",
      reason: "NO_MFA",
    });
    expect(await response.json()).toMatchObject({
      code: "RECIPIENT_INELIGIBLE",
      reason: "NO_MFA",
    });
  });

  it.each([
    "NOT_TRANSFER_RECIPIENT",
    "NOT_TRANSFER_INITIATOR",
    "PRIMARY_ADMIN_REQUIRED",
    "SELF_MODIFICATION",
    "TARGET_NOT_ELIGIBLE",
    "ACTOR_INACTIVE",
  ] as const)("answers an authorization reason, %s, with 403", async (code) => {
    const response = transferErrorResponse({ code });
    expect(response.status).toBe(403);
    expect(await response.json()).toEqual({
      code,
      message: "You do not have permission to do this.",
    });
  });
});

describe("positionErrorResponse", () => {
  const expected: Record<PositionErrorCode, number> = {
    INVALID_INPUT: 400,
    INVALID_KEY: 400,
    KEY_IMMUTABLE: 400,
    CONFIRM_KEY_MISMATCH: 400,
    POSITION_NOT_FOUND: 404,
    KEY_TAKEN: 409,
    KEY_RETIRED: 409,
    POSITION_DELETED: 409,
    POSITION_LIMIT: 409,
    MANAGER_NOT_FOUND: 409,
    MANAGER_CYCLE: 409,
  };

  it.each(Object.entries(expected))("maps %s to %i", async (code, status) => {
    const response = positionErrorResponse(
      new PositionError(code as PositionErrorCode),
    );
    expect(response.status).toBe(status);
    expect(await response.json()).toMatchObject({ code });
  });
});
