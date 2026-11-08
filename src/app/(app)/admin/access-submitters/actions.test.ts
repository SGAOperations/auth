import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  requireAdmin: vi.fn(),
  setSubmitterPositionKeys: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/admin-api", () => ({ requireAdmin: mocks.requireAdmin }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/audit", () => ({
  audit: vi.fn(),
  withAuditTransaction: vi.fn(),
}));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/access-submitters", async () => {
  const { AccessSubmitterError } = await vi.importActual<
    typeof import("@/lib/access-submitters")
  >("@/lib/access-submitters");
  return {
    AccessSubmitterError,
    setSubmitterPositionKeys: mocks.setSubmitterPositionKeys,
  };
});

import { AccessSubmitterError } from "@/lib/access-submitters";
import { saveSubmitterPositions } from "./actions";

const values = { keys: ["president"] };

beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireAdmin.mockResolvedValue({ actor: { id: "u1" } });
});

describe("the admin guard", () => {
  it("is called as a mutation gated on accessAdmin", async () => {
    mocks.setSubmitterPositionKeys.mockResolvedValue({ changed: false });
    await saveSubmitterPositions(values);
    expect(mocks.requireAdmin).toHaveBeenCalledWith({
      mutation: true,
      action: "accessAdmin",
    });
  });

  it.each([401, 403])(
    "returns FORBIDDEN for a %i and never calls the service",
    async (status) => {
      mocks.requireAdmin.mockResolvedValue({
        response: new Response(null, { status }),
      });
      expect(await saveSubmitterPositions(values)).toEqual({
        ok: false,
        code: "FORBIDDEN",
      });
      expect(mocks.setSubmitterPositionKeys).not.toHaveBeenCalled();
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("returns RATE_LIMITED for a 429 and never calls the service", async () => {
    mocks.requireAdmin.mockResolvedValue({
      response: new Response(null, { status: 429 }),
    });
    expect(await saveSubmitterPositions(values)).toEqual({
      ok: false,
      code: "RATE_LIMITED",
    });
    expect(mocks.setSubmitterPositionKeys).not.toHaveBeenCalled();
  });
});

describe("saveSubmitterPositions", () => {
  it("passes the input through unparsed, with the actor id", async () => {
    mocks.setSubmitterPositionKeys.mockResolvedValue({ changed: true });
    await saveSubmitterPositions("not even an object");
    expect(mocks.setSubmitterPositionKeys).toHaveBeenCalledWith(
      "not even an object",
      "u1",
    );
  });

  it("maps INVALID_INPUT with its field errors", async () => {
    mocks.setSubmitterPositionKeys.mockRejectedValue(
      new AccessSubmitterError("INVALID_INPUT", "bad", {
        fieldErrors: { keys: ["Too many"] },
      }),
    );
    expect(await saveSubmitterPositions(values)).toEqual({
      ok: false,
      code: "INVALID_INPUT",
      fieldErrors: { keys: ["Too many"] },
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("maps UNKNOWN_POSITION with the unknown keys", async () => {
    mocks.setSubmitterPositionKeys.mockRejectedValue(
      new AccessSubmitterError("UNKNOWN_POSITION", "gone", {
        unknownKeys: ["old-role"],
      }),
    );
    expect(await saveSubmitterPositions(values)).toEqual({
      ok: false,
      code: "UNKNOWN_POSITION",
      unknownKeys: ["old-role"],
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates once and returns ok when the list changed", async () => {
    mocks.setSubmitterPositionKeys.mockResolvedValue({ changed: true });
    expect(await saveSubmitterPositions(values)).toEqual({ ok: true });
    expect(mocks.revalidatePath).toHaveBeenCalledTimes(1);
    expect(mocks.revalidatePath).toHaveBeenCalledWith(
      "/admin/access-submitters",
    );
  });

  it("returns unchanged without revalidating when nothing changed", async () => {
    mocks.setSubmitterPositionKeys.mockResolvedValue({ changed: false });
    expect(await saveSubmitterPositions(values)).toEqual({
      ok: true,
      unchanged: true,
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("rethrows an unexpected error", async () => {
    mocks.setSubmitterPositionKeys.mockRejectedValue(new Error("db down"));
    await expect(saveSubmitterPositions(values)).rejects.toThrow("db down");
  });
});
