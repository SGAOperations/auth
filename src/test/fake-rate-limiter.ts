/** The result shape of `@upstash/ratelimit`'s `limit()`. */
export type RateLimitResult = {
  success: boolean;
  limit: number;
  remaining: number;
  /** Epoch ms at which the oldest hit leaves the window. */
  reset: number;
  pending: Promise<unknown>;
};

export type FakeRateLimiter = {
  limit(identifier: string): Promise<RateLimitResult>;
  /** While on, `limit()` rejects, to exercise the fail-open path. */
  setUnavailable(on: boolean): void;
  resetAll(): void;
  /** Every identifier passed to `limit()`, in order. */
  calls: string[];
};

/**
 * In-memory sliding-window limiter. It reads `Date.now()`, so a fake clock
 * drives window expiry.
 */
export function createFakeRateLimiter(options: {
  limit: number;
  windowMs: number;
}): FakeRateLimiter {
  const hits = new Map<string, number[]>();
  const calls: string[] = [];
  let unavailable = false;

  return {
    limit: async (identifier) => {
      calls.push(identifier);
      if (unavailable) throw new Error("fake Upstash unavailable");

      const now = Date.now();
      const live = (hits.get(identifier) ?? []).filter(
        (at) => at > now - options.windowMs,
      );
      const success = live.length < options.limit;
      if (success) live.push(now);
      hits.set(identifier, live);

      return {
        success,
        limit: options.limit,
        remaining: Math.max(0, options.limit - live.length),
        reset: (live[0] ?? now) + options.windowMs,
        pending: Promise.resolve(),
      };
    },
    setUnavailable: (on) => {
      unavailable = on;
    },
    resetAll: () => {
      hits.clear();
      calls.length = 0;
    },
    calls,
  };
}
