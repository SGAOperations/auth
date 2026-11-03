import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ checkRateLimit: vi.fn() }));

vi.mock("@/lib/rate-limit/server", () => ({
  checkRateLimit: mocks.checkRateLimit,
}));

import { POST } from "./route";

const IP = "203.0.113.9";

function report(body: unknown, contentType = "application/reports+json") {
  return POST(
    new Request("http://localhost:3000/api/csp-report", {
      method: "POST",
      headers: { "content-type": contentType, "x-real-ip": IP },
      body: JSON.stringify(body),
    }),
  );
}

const violation = {
  type: "csp-violation",
  body: { effectiveDirective: "img-src" },
};

let warn: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  mocks.checkRateLimit.mockResolvedValue({
    allowed: true,
    retryAfterSeconds: 0,
  });
  warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
});

describe("POST /api/csp-report", () => {
  it("logs a report and answers 204, limited per IP", async () => {
    const response = await report([violation]);
    expect(response.status).toBe(204);
    expect(mocks.checkRateLimit).toHaveBeenCalledWith("cspReport", { ip: IP });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  it("answers 429 with Retry-After over the limit and logs nothing (BT28)", async () => {
    mocks.checkRateLimit.mockResolvedValue({
      allowed: false,
      retryAfterSeconds: 42,
    });
    const response = await report([violation]);
    expect(response.status).toBe(429);
    expect(response.headers.get("Retry-After")).toBe("42");
    expect(warn).not.toHaveBeenCalled();
  });

  it("logs at most five lines for a body full of reports (BT28)", async () => {
    const response = await report(Array(200).fill(violation));
    expect(response.status).toBe(204);
    expect(warn).toHaveBeenCalledTimes(5);
  });

  it("refuses an unsupported type before the rate limit", async () => {
    const response = await report([violation], "text/plain");
    expect(response.status).toBe(415);
    expect(mocks.checkRateLimit).not.toHaveBeenCalled();
  });
});
