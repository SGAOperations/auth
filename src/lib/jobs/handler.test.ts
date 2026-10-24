import { describe, expect, it, vi } from "vitest";
import {
  createJobHandler,
  isAuthorized,
  notImplementedJob,
} from "@/lib/jobs/handler";

const SECRET = "j".repeat(32);

function setup(
  { secret }: { secret: string | undefined } = { secret: SECRET },
) {
  const run = vi.fn(async () => ({ executed: 2 }));
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const handler = createJobHandler({ name: "demo", run, secret, log });
  return { run, log, handler };
}

function request(authorization?: string) {
  return new Request("https://auth.example.test/api/jobs/demo", {
    method: "POST",
    headers: authorization ? { authorization } : {},
  });
}

describe("isAuthorized", () => {
  it("accepts exactly Bearer <secret>", () => {
    expect(isAuthorized(`Bearer ${SECRET}`, SECRET)).toBe(true);
  });

  it.each([
    ["no header", null],
    ["empty header", ""],
    ["another scheme", `Basic ${SECRET}`],
    ["a lower-case scheme", `bearer ${SECRET}`],
    ["a bare token", SECRET],
    ["no token", "Bearer "],
    ["no space", "Bearer"],
    ["a wrong token", `Bearer ${"x".repeat(32)}`],
    ["a shorter token", `Bearer ${SECRET.slice(1)}`],
    ["a longer token", `Bearer ${SECRET}x`],
  ])("rejects %s", (_label, header) => {
    expect(isAuthorized(header, SECRET)).toBe(false);
  });

  it("rejects everything when the secret is unset or empty", () => {
    expect(isAuthorized("Bearer ", "")).toBe(false);
    expect(isAuthorized("Bearer undefined", undefined)).toBe(false);
  });
});

describe("createJobHandler", () => {
  it.each([
    ["no header", undefined],
    ["a Basic header", `Basic ${SECRET}`],
    ["a wrong token", `Bearer ${"x".repeat(32)}`],
    ["a token of a different length", "Bearer short"],
    ["Bearer with no token", "Bearer "],
  ])("answers 401 and never runs for %s", async (_label, header) => {
    const { handler, run, log } = setup();
    const response = await handler(request(header));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(run).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("job.unauthorized", { job: "demo" });
  });

  it("answers 401 and never runs when the secret is unset", async () => {
    const { handler, run, log } = setup({ secret: undefined });
    const response = await handler(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(401);
    expect(await response.json()).toEqual({ error: "unauthorized" });
    expect(run).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledWith("job.secret_unset", { job: "demo" });
  });

  it("never logs the authorization header", async () => {
    const { handler, log } = setup();
    await handler(request("Bearer leaked-token-value"));
    expect(JSON.stringify(log.warn.mock.calls)).not.toContain(
      "leaked-token-value",
    );
  });

  it("runs once and answers 200 with the result", async () => {
    const { handler, run, log } = setup();
    const response = await handler(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      job: "demo",
      ok: true,
      result: { executed: 2 },
    });
    expect(run).toHaveBeenCalledTimes(1);
    expect(log.info).toHaveBeenCalledWith("job.completed", {
      job: "demo",
      executed: 2,
    });
  });

  it("answers 500 job_failed and logs the error when the job throws", async () => {
    const { handler, run, log } = setup();
    const boom = new Error("boom");
    run.mockRejectedValueOnce(boom);
    const response = await handler(request(`Bearer ${SECRET}`));

    expect(response.status).toBe(500);
    expect(await response.json()).toEqual({
      job: "demo",
      ok: false,
      error: "job_failed",
    });
    expect(log.error).toHaveBeenCalledWith("job.failed", {
      job: "demo",
      err: boom,
    });
  });

  it("marks every response no-store", async () => {
    const { handler, run } = setup();
    run.mockRejectedValueOnce(new Error("boom"));
    const responses = [
      await handler(request()),
      await handler(request(`Bearer ${SECRET}`)),
      await handler(request(`Bearer ${SECRET}`)),
    ];
    expect(responses.map((response) => response.status)).toEqual([
      401, 500, 200,
    ]);
    for (const response of responses) {
      expect(response.headers.get("cache-control")).toBe("no-store");
    }
  });
});

describe("notImplementedJob", () => {
  it("resolves a marker naming the ticket", async () => {
    await expect(notImplementedJob("#89")()).resolves.toEqual({
      status: "not_implemented",
      ticket: "#89",
    });
  });
});
