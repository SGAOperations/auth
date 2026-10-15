import { describe, expect, it, vi } from "vitest";
import type { Redis } from "@upstash/redis";
import {
  createUpstashBackend,
  type RatelimitLike,
} from "@/lib/rate-limit/upstash-backend";
import type { Rule } from "@/lib/rate-limit/policies";

const redis = {} as Redis;
const rule: Rule = {
  id: "sign-in:ip:1m",
  limit: 10,
  windowSeconds: 60,
  by: "ip",
};

describe("createUpstashBackend", () => {
  it("builds one limiter per rule with the namespaced prefix", async () => {
    const limit = vi.fn<RatelimitLike["limit"]>(async () => ({
      success: true,
      reset: 5,
    }));
    const createRatelimit = vi.fn(() => ({ limit }));
    const backend = createUpstashBackend({
      redis,
      prefix: "sgauth:prod:",
      createRatelimit,
    });

    await backend.limit("1.2.3.4", rule);
    await backend.limit("5.6.7.8", rule);

    expect(createRatelimit).toHaveBeenCalledTimes(1);
    expect(createRatelimit).toHaveBeenCalledWith(
      rule,
      "sgauth:prod:sign-in:ip:1m",
    );
    expect(limit).toHaveBeenCalledWith("1.2.3.4");
    expect(limit).toHaveBeenCalledWith("5.6.7.8");
  });

  it("maps success and reset", async () => {
    const backend = createUpstashBackend({
      redis,
      prefix: "p:",
      createRatelimit: () => ({
        limit: async () => ({ success: false, reset: 1234 }),
      }),
    });
    expect(await backend.limit("k", rule)).toEqual({
      success: false,
      resetMs: 1234,
    });
  });

  it("flags a timeout as fail-open", async () => {
    const backend = createUpstashBackend({
      redis,
      prefix: "p:",
      createRatelimit: () => ({
        limit: async () => ({ success: true, reset: 0, reason: "timeout" }),
      }),
    });
    expect((await backend.limit("k", rule)).failOpen).toBe("timeout");
  });

  it("propagates a thrown error", async () => {
    const backend = createUpstashBackend({
      redis,
      prefix: "p:",
      createRatelimit: () => ({
        limit: async () => {
          throw new Error("network down");
        },
      }),
    });
    await expect(backend.limit("k", rule)).rejects.toThrow("network down");
  });
});
