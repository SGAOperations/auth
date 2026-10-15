import "server-only";
import type { RateLimitBackend } from "@/lib/rate-limit/limiter";

interface MemoryBackendOptions {
  now?: () => number;
  maxKeys?: number;
}

/**
 * Sliding log per rule and key: the hit timestamps still inside the window.
 * Per instance, not shared, so it is only a fallback for local and preview and
 * the backend the tests use. A denied call records nothing, as on Upstash, so a
 * client that keeps hammering while blocked still recovers after the window.
 */
export function createMemoryBackend({
  now = Date.now,
  maxKeys = 10_000,
}: MemoryBackendOptions = {}): RateLimitBackend {
  const logs = new Map<string, number[]>();
  return {
    async limit(key, rule) {
      const slot = `${rule.id}:${key}`;
      const nowMs = now();
      const windowMs = rule.windowSeconds * 1000;
      const live = (logs.get(slot) ?? []).filter((at) => at > nowMs - windowMs);

      if (live.length >= rule.limit) {
        logs.set(slot, live);
        return { success: false, resetMs: live[0] + windowMs };
      }

      live.push(nowMs);
      // Delete first so the slot moves to the end of the insertion order, which
      // makes the first key the least recently admitted.
      logs.delete(slot);
      while (logs.size >= maxKeys) {
        const oldest = logs.keys().next().value;
        if (oldest === undefined) break;
        logs.delete(oldest);
      }
      logs.set(slot, live);
      return { success: true, resetMs: live[0] + windowMs };
    },
  };
}
