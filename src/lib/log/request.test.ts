import { describe, expect, it } from "vitest";
import { createLogger } from "@/lib/log/logger";
import { resolveRequestId, withRequestLogging } from "@/lib/log/request";
import { logLineSchema, type LogLevel } from "@/lib/log/schema";

function setup(handler: (req: Request) => Promise<Response>) {
  const lines: { line: string; level: LogLevel }[] = [];
  const log = createLogger({
    level: "debug",
    env: "production",
    write: (line, level) => lines.push({ line, level }),
  });
  const wrapped = withRequestLogging("/api/auth/[...all]", handler, log);
  const parsed = () =>
    lines.map((entry) => ({
      level: entry.level,
      raw: entry.line,
      body: JSON.parse(entry.line) as Record<string, unknown>,
    }));
  return { wrapped, lines, parsed };
}

const respond = (status: number) => async () => new Response(null, { status });

describe("resolveRequestId", () => {
  it("uses a well-formed x-vercel-id verbatim", () => {
    const headers = new Headers({ "x-vercel-id": "iad1::test-123" });
    expect(resolveRequestId(headers)).toBe("iad1::test-123");
  });

  it.each([
    ["missing", undefined],
    ["markup", "<script>"],
    ["too long", "a".repeat(200)],
  ])("generates a UUID when the header is %s", (_label, value) => {
    const headers = new Headers(value ? { "x-vercel-id": value } : {});
    expect(resolveRequestId(headers)).toMatch(/^[0-9a-f-]{36}$/);
  });
});

describe("withRequestLogging", () => {
  it.each([
    [200, "success", "info"],
    [401, "client_error", "info"],
    [500, "server_error", "error"],
  ] as const)("maps %i to %s at %s level", async (status, outcome, level) => {
    const { wrapped, parsed } = setup(respond(status));
    const response = await wrapped(new Request("http://x.test/api/auth/ok"));

    expect(response.status).toBe(status);
    const [entry] = parsed();
    expect(entry.level).toBe(level);
    expect(entry.body).toMatchObject({
      msg: "request.completed",
      status,
      outcome,
      route: "/api/auth/[...all]",
      method: "GET",
      path: "/api/auth/ok",
    });
    expect(entry.body.latencyMs).toBeGreaterThanOrEqual(0);
    expect(() => logLineSchema.parse(entry.body)).not.toThrow();
  });

  it("logs request.failed and rethrows when the handler throws", async () => {
    const boom = new Error("boom");
    const { wrapped, parsed } = setup(async () => {
      throw boom;
    });

    await expect(
      wrapped(new Request("http://x.test/api/auth/ok")),
    ).rejects.toBe(boom);
    const [entry] = parsed();
    expect(entry.level).toBe("error");
    expect(entry.body).toMatchObject({
      msg: "request.failed",
      outcome: "exception",
      err: { name: "Error", message: "boom" },
    });
    expect(() => logLineSchema.parse(entry.body)).not.toThrow();
  });

  it("carries the request id onto lines written inside the handler", async () => {
    const lines: string[] = [];
    const log = createLogger({
      level: "debug",
      env: "local",
      write: (line) => lines.push(line),
    });
    const wrapped = withRequestLogging(
      "/r",
      async () => {
        log.info("inside");
        return new Response(null);
      },
      log,
    );

    await wrapped(
      new Request("http://x.test/p", { headers: { "x-vercel-id": "id-1" } }),
    );
    expect(JSON.parse(lines[0])).toMatchObject({
      msg: "inside",
      requestId: "id-1",
    });
  });

  it("never logs the query string, headers or body", async () => {
    const { wrapped, parsed } = setup(respond(400));
    await wrapped(
      new Request(
        "http://x.test/api/auth/reset-password?token=QUERY_SENTINEL",
        {
          method: "POST",
          headers: {
            cookie: "session=COOKIE_SENTINEL",
            "content-type": "application/json",
          },
          body: JSON.stringify({ password: "PASSWORD_SENTINEL" }),
        },
      ),
    );

    const [entry] = parsed();
    expect(entry.body.path).toBe("/api/auth/reset-password");
    for (const secret of [
      "QUERY_SENTINEL",
      "COOKIE_SENTINEL",
      "PASSWORD_SENTINEL",
    ]) {
      expect(entry.raw).not.toContain(secret);
    }
  });
});
