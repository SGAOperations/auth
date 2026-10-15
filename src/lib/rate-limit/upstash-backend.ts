import "server-only";
import { Ratelimit } from "@upstash/ratelimit";
import type { Redis } from "@upstash/redis";
import type { RateLimitBackend } from "@/lib/rate-limit/limiter";
import type { Rule } from "@/lib/rate-limit/policies";

// A Ratelimit allows the request itself once this many milliseconds pass.
const TIMEOUT_MS = 1000;

export interface RatelimitLike {
  limit(
    identifier: string,
  ): Promise<{ success: boolean; reset: number; reason?: string }>;
}

export type CreateRatelimit = (rule: Rule, prefix: string) => RatelimitLike;

function defaultCreateRatelimit(redis: Redis): CreateRatelimit {
  return (rule, prefix) =>
    new Ratelimit({
      redis,
      limiter: Ratelimit.slidingWindow(rule.limit, `${rule.windowSeconds} s`),
      prefix,
      timeout: TIMEOUT_MS,
      analytics: false,
      ephemeralCache: new Map(),
    });
}

interface UpstashBackendOptions {
  redis: Redis;
  /** Environment namespace, for example `sgauth:prod:`. */
  prefix: string;
  createRatelimit?: CreateRatelimit;
}

/**
 * One sliding-window Ratelimit per rule, built on first use. The Redis key is
 * `<prefix><rule.id>:<identifier>`. Network and HTTP errors propagate and the
 * limiter turns them into a fail-open.
 */
export function createUpstashBackend({
  redis,
  prefix,
  createRatelimit = defaultCreateRatelimit(redis),
}: UpstashBackendOptions): RateLimitBackend {
  const limiters = new Map<string, RatelimitLike>();

  function limiterFor(rule: Rule): RatelimitLike {
    let limiter = limiters.get(rule.id);
    if (!limiter) {
      limiter = createRatelimit(rule, `${prefix}${rule.id}`);
      limiters.set(rule.id, limiter);
    }
    return limiter;
  }

  return {
    async limit(key, rule) {
      const result = await limiterFor(rule).limit(key);
      return {
        success: result.success,
        resetMs: result.reset,
        ...(result.reason === "timeout"
          ? { failOpen: "timeout" as const }
          : {}),
      };
    },
  };
}
