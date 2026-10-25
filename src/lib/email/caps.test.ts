import { describe, expect, it, vi } from "vitest";
import {
  createEmailCaps,
  createMemoryCapStore,
  createUpstashCapStore,
  type CapStore,
} from "./caps";

function setup(options: { dailyCap?: number; store?: CapStore } = {}) {
  const clock = { now: Date.UTC(2026, 9, 16, 10, 0, 0) };
  const now = () => clock.now;
  const log = { error: vi.fn() };
  const store = options.store ?? createMemoryCapStore({ now });
  const caps = createEmailCaps({
    store,
    dailyCap: options.dailyCap ?? 500,
    log,
    now,
  });
  return { caps, log, clock };
}

async function sendMany(
  caps: ReturnType<typeof createEmailCaps>,
  hash: string,
  count: number,
) {
  const results = [];
  for (let i = 0; i < count; i += 1) results.push(await caps.check(hash));
  return results;
}

describe("recipient caps", () => {
  it("refuses the 11th send in an hour, and allows the next hour", async () => {
    const { caps, clock } = setup();
    const results = await sendMany(caps, "a", 11);
    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[10]).toEqual({ allowed: false, cap: "recipient:1h" });

    clock.now += 60 * 60 * 1000;
    expect(await caps.check("a")).toEqual({ allowed: true });
  });

  it("refuses the 31st send in a UTC day", async () => {
    const { caps, clock } = setup();
    for (let i = 0; i < 30; i += 1) {
      // Spread over hours so only the daily cap can trip.
      clock.now = Date.UTC(2026, 9, 16, i % 20, 0, 0);
      expect(await caps.check("a")).toEqual({ allowed: true });
    }
    clock.now = Date.UTC(2026, 9, 16, 21, 0, 0);
    expect(await caps.check("a")).toEqual({
      allowed: false,
      cap: "recipient:1d",
    });
  });

  it("starts a new day at 00:00 UTC", async () => {
    const { caps, clock } = setup();
    for (let i = 0; i < 31; i += 1) {
      clock.now = Date.UTC(2026, 9, 16, i % 20, 0, 0);
      await caps.check("a");
    }
    clock.now = Date.UTC(2026, 9, 17, 0, 0, 0);
    expect(await caps.check("a")).toEqual({ allowed: true });
  });

  it("keeps recipients apart", async () => {
    const { caps } = setup();
    await sendMany(caps, "a", 11);
    expect(await caps.check("b")).toEqual({ allowed: true });
  });

  it("leaves the global count unchanged on a recipient refusal", async () => {
    const { caps, log } = setup({ dailyCap: 12 });
    // 10 allowed sends for "a", then 5 refused.
    await sendMany(caps, "a", 15);
    // The global count is 10, so 2 more sends from others still pass.
    expect(await caps.check("b")).toEqual({ allowed: true });
    expect(await caps.check("c")).toEqual({ allowed: true });
    expect(await caps.check("d")).toEqual({ allowed: false, cap: "global:1d" });
    expect(log.error).toHaveBeenCalledWith("[ALERT] email daily cap reached", {
      dailyCap: 12,
    });
  });
});

describe("global daily cap", () => {
  it("alerts at 80%, refuses past the cap, and alerts once each", async () => {
    const { caps, log } = setup({ dailyCap: 10 });
    const results = [];
    for (let i = 0; i < 12; i += 1) results.push(await caps.check(`r${i}`));

    expect(results.slice(0, 10).every((r) => r.allowed)).toBe(true);
    expect(results[10]).toEqual({ allowed: false, cap: "global:1d" });
    expect(results[11]).toEqual({ allowed: false, cap: "global:1d" });

    const messages = log.error.mock.calls.map(([msg]) => msg);
    expect(messages).toEqual([
      "[ALERT] email daily cap 80%",
      "[ALERT] email daily cap reached",
    ]);
    expect(log.error.mock.calls[0][1]).toEqual({ count: 8, dailyCap: 10 });
  });

  it("fires the 80% alert on the 8th send, not before", async () => {
    const { caps, log } = setup({ dailyCap: 10 });
    for (let i = 0; i < 7; i += 1) await caps.check(`r${i}`);
    expect(log.error).not.toHaveBeenCalled();
    await caps.check("r7");
    expect(log.error).toHaveBeenCalledTimes(1);
  });

  it("resets on the next UTC day", async () => {
    const { caps, clock } = setup({ dailyCap: 2 });
    await sendMany(caps, "a", 1);
    await sendMany(caps, "b", 1);
    expect((await caps.check("c")).allowed).toBe(false);
    clock.now = Date.UTC(2026, 9, 17, 0, 0, 0);
    expect((await caps.check("c")).allowed).toBe(true);
  });
});

describe("fail-open", () => {
  const failing: CapStore = {
    incr: () => Promise.reject(new TypeError("https://secret.upstash.io down")),
  };

  it("allows the send and alerts once a minute with a suppressed count", async () => {
    const { caps, log, clock } = setup({ store: failing });

    expect(await caps.check("a")).toEqual({ allowed: true });
    expect(await caps.check("a")).toEqual({ allowed: true });
    expect(await caps.check("a")).toEqual({ allowed: true });
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenLastCalledWith("[ALERT] email cap fail-open", {
      reason: "error",
      errorName: "TypeError",
    });

    clock.now += 61_000;
    await caps.check("a");
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenLastCalledWith("[ALERT] email cap fail-open", {
      reason: "error",
      errorName: "TypeError",
      suppressed: 2,
    });
  });

  it("calls onFailOpen once per written line and never for a suppressed one", async () => {
    const onFailOpen = vi.fn();
    const clock = { now: Date.UTC(2026, 9, 16, 10, 0, 0) };
    const caps = createEmailCaps({
      store: failing,
      dailyCap: 500,
      log: { error: vi.fn() },
      onFailOpen,
      now: () => clock.now,
    });

    await caps.check("a");
    await caps.check("a");
    expect(onFailOpen).toHaveBeenCalledTimes(1);
    expect(onFailOpen).toHaveBeenCalledWith({ reason: "error" });

    clock.now += 61_000;
    await caps.check("a");
    expect(onFailOpen).toHaveBeenCalledTimes(2);
  });

  it("still allows the send when onFailOpen throws", async () => {
    const caps = createEmailCaps({
      store: failing,
      dailyCap: 500,
      log: { error: vi.fn() },
      onFailOpen: () => {
        throw new Error("boom");
      },
    });
    expect(await caps.check("a")).toEqual({ allowed: true });
  });

  it("never logs the error message or the hash", async () => {
    const { caps, log } = setup({ store: failing });
    await caps.check("hash-value");
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain("secret.upstash.io");
    expect(logged).not.toContain("hash-value");
  });
});

describe("Upstash store", () => {
  function fakeRedis(results: unknown[]) {
    const calls: string[] = [];
    const pipeline = {
      incr: (key: string) => {
        calls.push(`incr ${key}`);
        return pipeline;
      },
      expire: (key: string, seconds: number) => {
        calls.push(`expire ${key} ${seconds}`);
        return pipeline;
      },
      exec: () => Promise.resolve(results),
    };
    return { redis: { pipeline: () => pipeline }, calls };
  }

  it("sends incr and expire for each namespaced key, and returns the counts", async () => {
    const { redis, calls } = fakeRedis([4, 1, 9, 1]);
    const store = createUpstashCapStore({ redis, prefix: "sgauth:dev:" });
    const counts = await store.incr([
      { key: "email:rcpt:1h:abc:2026101610", ttlSeconds: 7200 },
      { key: "email:rcpt:1d:abc:20261016", ttlSeconds: 172800 },
    ]);
    expect(counts).toEqual([4, 9]);
    expect(calls).toEqual([
      "incr sgauth:dev:email:rcpt:1h:abc:2026101610",
      "expire sgauth:dev:email:rcpt:1h:abc:2026101610 7200",
      "incr sgauth:dev:email:rcpt:1d:abc:20261016",
      "expire sgauth:dev:email:rcpt:1d:abc:20261016 172800",
    ]);
  });

  it("rejects on a malformed response", async () => {
    const { redis } = fakeRedis(["nope", 1]);
    const store = createUpstashCapStore({ redis, prefix: "p:" });
    await expect(store.incr([{ key: "k", ttlSeconds: 1 }])).rejects.toThrow();
  });

  it("rejects after one second when the pipeline hangs", async () => {
    vi.useFakeTimers();
    try {
      const pipeline = {
        incr: () => pipeline,
        expire: () => pipeline,
        exec: () => new Promise<unknown[]>(() => {}),
      };
      const store = createUpstashCapStore({
        redis: { pipeline: () => pipeline },
        prefix: "p:",
      });
      const outcome = store.incr([{ key: "k", ttlSeconds: 1 }]);
      const assertion = expect(outcome).rejects.toThrow("timed out");
      await vi.advanceTimersByTimeAsync(1000);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("namespaced keys through the caps", () => {
  it("uses the three documented key shapes", async () => {
    const keys: string[] = [];
    const store: CapStore = {
      incr: async (entries) => {
        keys.push(...entries.map((entry) => entry.key));
        return entries.map(() => 1);
      },
    };
    const { caps } = setup({ store });
    await caps.check("abc");
    expect(keys).toEqual([
      "email:rcpt:1h:abc:2026101610",
      "email:rcpt:1d:abc:20261016",
      "email:global:1d:20261016",
    ]);
  });
});
