import { describe, expect, it } from "vitest";
import { resultFromResponse } from "@/lib/admin/response-result";

const answer = (status: number, body: unknown) =>
  Response.json(body, { status });

describe("resultFromResponse", () => {
  it("passes a success through, with the email status when there is one", async () => {
    expect(await resultFromResponse(answer(200, { user: {} }))).toEqual({
      ok: true,
    });
    expect(
      await resultFromResponse(answer(200, { user: {}, email: "failed" })),
    ).toEqual({ ok: true, email: "failed" });
  });

  it("reads REAUTH_REQUIRED as a re-auth prompt", async () => {
    expect(
      await resultFromResponse(answer(403, { code: "REAUTH_REQUIRED" })),
    ).toEqual({ ok: false, code: "REAUTH_REQUIRED" });
  });

  it("keeps the authorization reason of a denial", async () => {
    expect(
      await resultFromResponse(answer(403, { code: "SELF_MODIFICATION" })),
    ).toEqual({ ok: false, code: "FORBIDDEN", reason: "SELF_MODIFICATION" });
  });

  it("maps the codes the pages have copy for", async () => {
    const code = async (status: number, body: unknown) => {
      const result = await resultFromResponse(answer(status, body));
      return result.ok ? "ok" : result.code;
    };
    expect(await code(409, { code: "POSITION_LIMIT" })).toBe("POSITION_LIMIT");
    expect(await code(409, { code: "POSITION_DELETED" })).toBe(
      "POSITION_DELETED",
    );
    expect(await code(404, { code: "USER_NOT_FOUND" })).toBe("NOT_FOUND");
    expect(await code(404, { code: "POSITION_NOT_FOUND" })).toBe("NOT_FOUND");
    expect(await code(400, { code: "INVALID_INPUT" })).toBe("VALIDATION");
    expect(await code(429, { code: "INVITE_LIMIT" })).toBe("RATE_LIMITED");
    expect(await code(429, {})).toBe("RATE_LIMITED");
  });

  it("carries the server's line for an unmapped conflict", async () => {
    expect(
      await resultFromResponse(
        answer(409, { code: "ALREADY_ADMIN", message: "Already an admin." }),
      ),
    ).toEqual({
      ok: false,
      code: "CONFLICT",
      message: "Already an admin.",
    });
  });

  it("treats other 4xx by status and an unreadable or 5xx answer as unexpected", async () => {
    const code = async (response: Response) => {
      const result = await resultFromResponse(response);
      return result.ok ? "ok" : result.code;
    };
    expect(await code(answer(401, { code: "UNAUTHENTICATED" }))).toBe(
      "FORBIDDEN",
    );
    expect(await code(answer(403, { code: "MFA_REQUIRED" }))).toBe("FORBIDDEN");
    expect(await code(answer(500, { code: "INTERNAL_ERROR" }))).toBe(
      "UNEXPECTED",
    );
    expect(await code(new Response("<html>", { status: 502 }))).toBe(
      "UNEXPECTED",
    );
  });
});
