import { describe, expect, it, vi } from "vitest";
import { createReauthRoute } from "@/lib/auth/reauth-route";

function setup({
  session = { user: { id: "u1" } } as { user: { id: string } } | null,
  limited = null as Response | null,
} = {}) {
  const getSession = vi.fn().mockResolvedValue(session);
  const limit = vi.fn().mockResolvedValue(limited);
  const reauthenticate = vi
    .fn()
    .mockResolvedValue(Response.json({ status: true }));
  const POST = createReauthRoute({ getSession, limit, reauthenticate });
  return { POST, getSession, limit, reauthenticate };
}

const post = (body: BodyInit, headers: Record<string, string> = {}) =>
  new Request("http://localhost:3000/api/sgauth/reauth", {
    method: "POST",
    headers: { "content-type": "application/json", ...headers },
    body,
  });

describe("POST /api/sgauth/reauth", () => {
  it("answers 401 with no session, before the rate limit", async () => {
    const { POST, limit, reauthenticate } = setup({ session: null });
    const response = await POST(post(JSON.stringify({ password: "pw" })));
    expect(response.status).toBe(401);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toMatchObject({ code: "UNAUTHORIZED" });
    expect(limit).not.toHaveBeenCalled();
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("returns the rate limiter's 429 and goes no further", async () => {
    const limited = new Response(null, {
      status: 429,
      headers: { "Retry-After": "30" },
    });
    const { POST, limit, reauthenticate } = setup({ limited });
    const response = await POST(post(JSON.stringify({ password: "pw" })));
    expect(response).toBe(limited);
    expect(limit).toHaveBeenCalledWith("u1");
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it.each([
    ["a body that is not JSON", "not json"],
    ["an unknown key", JSON.stringify({ password: "pw", extra: 1 })],
    ["an empty password", JSON.stringify({ password: "" })],
  ])("answers 400 INVALID_REQUEST for %s", async (_label, body) => {
    const { POST, reauthenticate } = setup();
    const response = await POST(post(body));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    expect(await response.json()).toEqual({
      code: "INVALID_REQUEST",
      message: "Invalid request.",
    });
    expect(reauthenticate).not.toHaveBeenCalled();
  });

  it("hands the parsed body and the original headers to the check", async () => {
    const { POST, reauthenticate } = setup();
    const response = await POST(
      post(JSON.stringify({ password: "pw", code: " 123456 " }), {
        cookie: "a=b",
      }),
    );
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(response.headers.get("Cache-Control")).toBe("no-store");
    const [input] = reauthenticate.mock.calls[0];
    expect(input.body).toEqual({ password: "pw", code: "123456" });
    expect(input.headers.get("cookie")).toBe("a=b");
  });

  it("passes the check's failure status through", async () => {
    const { POST, reauthenticate } = setup();
    reauthenticate.mockResolvedValue(
      Response.json({ code: "INVALID_REAUTH_CREDENTIALS" }, { status: 400 }),
    );
    const response = await POST(post(JSON.stringify({ password: "pw" })));
    expect(response.status).toBe(400);
    expect(response.headers.get("Cache-Control")).toBe("no-store");
  });
});
