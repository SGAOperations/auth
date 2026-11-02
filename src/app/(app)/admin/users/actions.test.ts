import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
  remove: vi.fn(),
  headers: vi.fn(),
  revalidatePath: vi.fn(),
}));

vi.mock("@/lib/admin/users/server", () => ({
  liveAdminUserHandlers: { remove: mocks.remove },
}));
vi.mock("next/headers", () => ({ headers: mocks.headers }));
vi.mock("next/cache", () => ({ revalidatePath: mocks.revalidatePath }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({ logger: { error: vi.fn() } }));
vi.mock("@/lib/auth/server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/admin-api", () => ({ requireAdmin: vi.fn() }));
vi.mock("@/lib/admin/user-sessions", () => ({ revokeUserSession: vi.fn() }));
vi.mock("@/app/api/sgauth/admin/users/[id]/positions/route", () => ({
  PATCH: vi.fn(),
}));
vi.mock("@/app/api/sgauth/admin/users/[id]/email/route", () => ({
  POST: vi.fn(),
}));

import { failureMessage, REASON_COPY } from "@/lib/admin/denial-copy";
import { deleteUser } from "./actions";

const ID = "0192ab3c-0000-7f60-8a1b-000000000001";

const answer = (status: number, body: unknown) =>
  Response.json(body, { status });

beforeEach(() => {
  vi.resetAllMocks();
  mocks.headers.mockResolvedValue(
    new Headers({
      cookie: "session=abc",
      origin: "https://auth.example.edu",
      host: "auth.example.edu",
    }),
  );
});

describe("deleteUser", () => {
  it("returns NOT_FOUND for a malformed id and never calls the handler", async () => {
    expect(await deleteUser("nope")).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(mocks.remove).not.toHaveBeenCalled();
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("sends a DELETE to the user's endpoint and revalidates on success", async () => {
    mocks.remove.mockResolvedValue(answer(200, { user: {} }));
    expect(await deleteUser(ID)).toEqual({ ok: true });
    expect(mocks.remove).toHaveBeenCalledTimes(1);
    const [request, ctx] = mocks.remove.mock.calls[0] as [
      Request,
      { params: Promise<{ id: string }> },
    ];
    expect(request.method).toBe("DELETE");
    expect(new URL(request.url).pathname).toBe(`/api/sgauth/admin/users/${ID}`);
    expect(request.headers.get("cookie")).toBe("session=abc");
    expect(request.headers.get("origin")).toBe("https://auth.example.edu");
    expect((await ctx.params).id).toBe(ID);
    expect(mocks.revalidatePath).toHaveBeenCalledWith("/admin/users");
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/admin/users/${ID}`);
  });

  it("reads REAUTH_REQUIRED as a re-auth prompt", async () => {
    mocks.remove.mockResolvedValue(answer(403, { code: "REAUTH_REQUIRED" }));
    expect(await deleteUser(ID)).toEqual({
      ok: false,
      code: "REAUTH_REQUIRED",
    });
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it.each(["SELF_MODIFICATION", "PRIMARY_ADMIN_PROTECTED"] as const)(
    "keeps %s as a FORBIDDEN reason with its copy",
    async (reason) => {
      mocks.remove.mockResolvedValue(answer(403, { code: reason }));
      const result = await deleteUser(ID);
      expect(result).toEqual({ ok: false, code: "FORBIDDEN", reason });
      if (result.ok) throw new Error("expected a failure");
      expect(failureMessage(result)).toBe(REASON_COPY[reason]);
      expect(mocks.revalidatePath).not.toHaveBeenCalled();
    },
  );

  it("keeps the server's line for an already deleted user", async () => {
    mocks.remove.mockResolvedValue(
      answer(409, {
        code: "USER_DELETED",
        message: "This account has been deleted.",
      }),
    );
    const result = await deleteUser(ID);
    expect(result).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "This account has been deleted.",
    });
    if (result.ok) throw new Error("expected a failure");
    expect(failureMessage(result)).toBe("This account has been deleted.");
    expect(mocks.revalidatePath).not.toHaveBeenCalled();
  });

  it("revalidates when the user no longer exists", async () => {
    mocks.remove.mockResolvedValue(answer(404, { code: "USER_NOT_FOUND" }));
    expect(await deleteUser(ID)).toEqual({ ok: false, code: "NOT_FOUND" });
    expect(mocks.revalidatePath).toHaveBeenCalledWith(`/admin/users/${ID}`);
  });
});
