import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ handler: vi.fn() }));

vi.mock("@/lib/auth/server", () => ({ auth: { handler: mocks.handler } }));
vi.mock("@/lib/log", () => ({ logger: {} }));
vi.mock("@/lib/log/request", () => ({
  withRequestLogging:
    (_route: string, handler: (req: Request) => Promise<Response>) =>
    (req: Request) =>
      handler(req),
}));

import { GET } from "./route";

describe("GET /api/sgauth/jwks", () => {
  beforeEach(() => {
    mocks.handler.mockReset();
    mocks.handler.mockResolvedValue(Response.json({ keys: [] }));
  });

  it("hands the auth handler the /api/auth/jwks path, keeping the origin", async () => {
    await GET(new Request("https://auth.example.test/.well-known/jwks.json"));

    expect(mocks.handler).toHaveBeenCalledTimes(1);
    const forwarded = mocks.handler.mock.calls[0][0] as Request;
    expect(forwarded.method).toBe("GET");
    expect(new URL(forwarded.url).origin).toBe("https://auth.example.test");
    expect(new URL(forwarded.url).pathname).toBe("/api/auth/jwks");
  });

  it("returns the auth handler's response unchanged", async () => {
    const response = await GET(
      new Request("https://auth.example.test/.well-known/jwks.json"),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ keys: [] });
  });
});
