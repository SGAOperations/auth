import { afterEach, describe, expect, it, vi } from "vitest";
import { CHECK_TIMEOUT_MS, runHealthChecks, type HealthProbes } from "./checks";

const log = { error: vi.fn() };

function probes(overrides: Partial<HealthProbes> = {}): HealthProbes {
  return {
    pingDb: async () => {},
    hasJwksKey: async () => true,
    version: "abc1234",
    ...overrides,
  };
}

afterEach(() => {
  vi.useRealTimers();
  log.error.mockClear();
});

describe("runHealthChecks", () => {
  it("returns 200 when both probes are ok", async () => {
    const result = await runHealthChecks(probes(), log);
    expect(result).toEqual({
      status: 200,
      body: { db: "ok", jwks: "ok", version: "abc1234" },
    });
    expect(log.error).not.toHaveBeenCalled();
  });

  it("returns 503 with db error when the database ping rejects", async () => {
    const result = await runHealthChecks(
      probes({ pingDb: async () => Promise.reject(new Error("down")) }),
      log,
    );
    expect(result.status).toBe(503);
    expect(result.body.db).toBe("error");
    expect(result.body.jwks).toBe("ok");
  });

  it("returns 503 with jwks missing when no key row exists", async () => {
    const result = await runHealthChecks(
      probes({ hasJwksKey: async () => false }),
      log,
    );
    expect(result.status).toBe(503);
    expect(result.body.jwks).toBe("missing");
    expect(log.error).not.toHaveBeenCalled();
  });

  it("reports jwks error when the key lookup rejects", async () => {
    const result = await runHealthChecks(
      probes({ hasJwksKey: async () => Promise.reject(new Error("boom")) }),
      log,
    );
    expect(result.status).toBe(503);
    expect(result.body.jwks).toBe("error");
  });

  it("reports error once a probe exceeds the timeout", async () => {
    vi.useFakeTimers();
    const pending = runHealthChecks(
      probes({ pingDb: () => new Promise<void>(() => {}) }),
      log,
    );
    await vi.advanceTimersByTimeAsync(CHECK_TIMEOUT_MS);
    const result = await pending;
    expect(result.status).toBe(503);
    expect(result.body.db).toBe("error");
    expect(result.body.jwks).toBe("ok");
  });

  it("never puts a failure's message in the body", async () => {
    const secret = "postgresql://runtime:hunter2@db.example/neondb";
    const result = await runHealthChecks(
      probes({
        pingDb: async () => Promise.reject(new Error(secret)),
        hasJwksKey: async () => Promise.reject(new Error(secret)),
      }),
      log,
    );
    expect(JSON.stringify(result)).not.toContain("hunter2");
    expect(log.error).toHaveBeenCalledTimes(2);
  });
});
