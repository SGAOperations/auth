import { describe, expect, it, vi } from "vitest";
import { z } from "zod";
import {
  createProductApiHandler,
  type ProductApiOptions,
} from "@/lib/product-api/handler";
import type { AuthenticatedProduct } from "@/lib/product-api-keys";

const PRODUCT: AuthenticatedProduct = {
  productId: "0192f0a0-0000-7000-8000-00000000000b",
  slug: "chambers",
  keyId: "0192f0a0-0000-7000-8000-00000000000a",
};

const schema = z.strictObject({ n: z.number() });
type Options = ProductApiOptions<typeof schema>;

function setup(overrides: Partial<Options> = {}) {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const run = vi.fn<Options["run"]>(async (_product, input) => ({
    status: 200,
    body: { doubled: input.n * 2 },
  }));
  const handler = createProductApiHandler({
    name: "test",
    enabled: true,
    schema,
    authenticate: async (header) => (header === "Bearer good" ? PRODUCT : null),
    limit: async () => null,
    run,
    log,
    ...overrides,
  });
  return { handler, run, log };
}

const request = (body: unknown, authorization = "Bearer good") =>
  new Request("https://auth.example/api/products/test", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("createProductApiHandler", () => {
  it("runs with the product and the parsed body", async () => {
    const { handler, run } = setup();
    const response = await handler(request({ n: 2 }));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual({ doubled: 4 });
    expect(run).toHaveBeenCalledWith(PRODUCT, { n: 2 });
  });

  it("answers 404 while disabled, before anything else", async () => {
    const authenticate = vi.fn();
    const { handler } = setup({ enabled: false, authenticate });
    expect((await handler(request({ n: 1 }))).status).toBe(404);
    expect(authenticate).not.toHaveBeenCalled();
  });

  it("answers 401 for a bad key and never runs", async () => {
    const { handler, run, log } = setup();
    const response = await handler(request({ n: 1 }, "Bearer bad"));
    expect(response.status).toBe(401);
    expect(run).not.toHaveBeenCalled();
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain("Bearer");
  });

  it("passes on the limiter's 429 and never runs", async () => {
    const limited = new Response(null, { status: 429 });
    const { handler, run } = setup({ limit: async () => limited });
    expect(await handler(request({ n: 1 }))).toBe(limited);
    expect(run).not.toHaveBeenCalled();
  });

  it("answers 400 for a body that is not JSON", async () => {
    const { handler } = setup();
    const response = await handler(request("{"));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "bad_request",
      issues: ["$"],
    });
  });

  it("names a bad or extra field, never its value", async () => {
    const { handler } = setup();
    const response = await handler(request({ n: "secret", extra: "secret" }));
    expect(response.status).toBe(400);
    const body = await response.json();
    expect(body.issues).toEqual(expect.arrayContaining(["n", "extra"]));
    expect(JSON.stringify(body)).not.toContain("secret");
  });

  it("answers a refusal from run with its status", async () => {
    const { handler } = setup({
      run: async () => ({ status: 403, error: "wrong_team" }),
    });
    const response = await handler(request({ n: 1 }));
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toEqual({ error: "wrong_team" });
  });

  it("answers 500 when run throws, and logs the error name only", async () => {
    const { handler, log } = setup({
      run: async () => {
        throw new TypeError("leaky detail");
      },
    });
    const response = await handler(request({ n: 1 }));
    expect(response.status).toBe(500);
    expect(log.error).toHaveBeenCalledWith("test.failed", {
      product: "chambers",
      errorName: "TypeError",
    });
  });
});
