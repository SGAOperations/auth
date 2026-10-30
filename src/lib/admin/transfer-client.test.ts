import { describe, expect, it, vi } from "vitest";
import { postTransferAction } from "@/lib/admin/transfer-client";

const json = (body: unknown, status: number) => Response.json(body, { status });

describe("postTransferAction", () => {
  it("sends same-origin JSON and returns the new transfer's id", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        json({ transfer: { id: "t1", status: "PENDING_ACCEPTANCE" } }, 201),
      );
    const result = await postTransferAction(
      "/api/sgauth/admin/transfer",
      { recipientUserId: "u1", confirmEmail: "a@x.edu" },
      send,
    );
    expect(result).toEqual({ kind: "ok", id: "t1" });
    expect(send).toHaveBeenCalledWith("/api/sgauth/admin/transfer", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ recipientUserId: "u1", confirmEmail: "a@x.edu" }),
    });
  });

  it("maps a 403 REAUTH_REQUIRED to reauth", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(json({ code: "REAUTH_REQUIRED", message: "x" }, 403));
    expect(await postTransferAction("/p", {}, send)).toEqual({
      kind: "reauth",
    });
  });

  it("keeps the code and reason of a named refusal", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(
        json(
          { code: "RECIPIENT_INELIGIBLE", message: "x", reason: "NO_MFA" },
          409,
        ),
      );
    expect(await postTransferAction("/p", {}, send)).toEqual({
      kind: "error",
      code: "RECIPIENT_INELIGIBLE",
      reason: "NO_MFA",
    });
  });

  it("treats other 403 codes as a refusal, not a re-auth", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(json({ code: "NOT_ADMIN", message: "x" }, 403));
    expect(await postTransferAction("/p", {}, send)).toEqual({
      kind: "error",
      code: "NOT_ADMIN",
    });
  });

  it("maps 429 to RATE_LIMITED whatever the body", async () => {
    const send = vi
      .fn()
      .mockResolvedValue(new Response("slow down", { status: 429 }));
    expect(await postTransferAction("/p", {}, send)).toEqual({
      kind: "error",
      code: "RATE_LIMITED",
    });
  });

  it("is unexpected for a network failure, a 5xx, or an unreadable body", async () => {
    expect(
      await postTransferAction(
        "/p",
        {},
        vi.fn().mockRejectedValue(new Error("x")),
      ),
    ).toEqual({ kind: "unexpected" });
    expect(
      await postTransferAction(
        "/p",
        {},
        vi.fn().mockResolvedValue(json({ code: "BOOM" }, 500)),
      ),
    ).toEqual({ kind: "unexpected" });
    expect(
      await postTransferAction(
        "/p",
        {},
        vi.fn().mockResolvedValue(new Response("<html>", { status: 400 })),
      ),
    ).toEqual({ kind: "unexpected" });
    expect(
      await postTransferAction(
        "/p",
        {},
        vi.fn().mockResolvedValue(json({ nope: true }, 200)),
      ),
    ).toEqual({ kind: "unexpected" });
  });
});
