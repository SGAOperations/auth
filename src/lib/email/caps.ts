import "server-only";

// Send caps, counted in fixed UTC windows (calendar hour and UTC day). A fixed
// window allows up to twice a cap across a boundary; that is acceptable for
// bounding abuse, and it lets each alert fire exactly once a day.

export const RECIPIENT_HOURLY_CAP = 10;
export const RECIPIENT_DAILY_CAP = 30;
export const ALERT_RATIO = 0.8;

const HOUR_TTL_SECONDS = 2 * 60 * 60;
const DAY_TTL_SECONDS = 2 * 24 * 60 * 60;
const STORE_TIMEOUT_MS = 1000;
const FAIL_OPEN_ALERT_INTERVAL_MS = 60_000;

export type CapName = "recipient:1h" | "recipient:1d" | "global:1d";

export type CapDecision = { allowed: true } | { allowed: false; cap: CapName };

export interface CapStore {
  /** Increments every key, sets its expiry, and returns the new counts. */
  incr(entries: { key: string; ttlSeconds: number }[]): Promise<number[]>;
}

export interface CapLog {
  error(msg: string, fields?: Record<string, unknown>): void;
}

class CapStoreTimeoutError extends Error {
  constructor() {
    super("Cap store timed out");
    this.name = "CapStoreTimeoutError";
  }
}

interface PipelineLike {
  incr(key: string): unknown;
  expire(key: string, seconds: number): unknown;
  exec(): Promise<unknown[]>;
}

export interface CapRedis {
  pipeline(): PipelineLike;
}

/**
 * One pipeline holding an `INCR` and an `EXPIRE` per key, bounded to one
 * second. A timeout or any error rejects, and the caps turn that into a
 * fail-open.
 */
export function createUpstashCapStore({
  redis,
  prefix,
}: {
  redis: CapRedis;
  /** Environment namespace, for example `sgauth:prod:`. */
  prefix: string;
}): CapStore {
  return {
    async incr(entries) {
      const pipeline = redis.pipeline();
      for (const { key, ttlSeconds } of entries) {
        pipeline.incr(`${prefix}${key}`);
        pipeline.expire(`${prefix}${key}`, ttlSeconds);
      }

      let timer: ReturnType<typeof setTimeout> | undefined;
      const timeout = new Promise<never>((_, reject) => {
        timer = setTimeout(
          () => reject(new CapStoreTimeoutError()),
          STORE_TIMEOUT_MS,
        );
      });
      try {
        const results = await Promise.race([pipeline.exec(), timeout]);
        // Results alternate incr, expire, incr, expire, ...
        return entries.map((_, index) => {
          const count = results[index * 2];
          if (typeof count !== "number") {
            throw new Error("Unexpected cap store response");
          }
          return count;
        });
      } finally {
        clearTimeout(timer);
      }
    },
  };
}

/** Per instance, for local, preview and tests. */
export function createMemoryCapStore({
  now = Date.now,
}: { now?: () => number } = {}): CapStore {
  const counters = new Map<string, { count: number; expiresAt: number }>();
  return {
    async incr(entries) {
      const nowMs = now();
      for (const [key, counter] of counters) {
        if (counter.expiresAt <= nowMs) counters.delete(key);
      }
      return entries.map(({ key, ttlSeconds }) => {
        const existing = counters.get(key);
        const live = existing && existing.expiresAt > nowMs ? existing : null;
        const count = (live?.count ?? 0) + 1;
        counters.set(key, {
          count,
          expiresAt: live?.expiresAt ?? nowMs + ttlSeconds * 1000,
        });
        return count;
      });
    },
  };
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

function utcDay(date: Date): string {
  return `${date.getUTCFullYear()}${pad(date.getUTCMonth() + 1)}${pad(date.getUTCDate())}`;
}

interface EmailCapsOptions {
  store: CapStore;
  dailyCap: number;
  log: CapLog;
  now?: () => number;
}

export function createEmailCaps({
  store,
  dailyCap,
  log,
  now = Date.now,
}: EmailCapsOptions) {
  let lastFailOpenAlert: { at: number; suppressed: number } | null = null;

  // Never logs the key, the hash or the error message: the message can carry
  // the REST URL.
  function alertFailOpen(error: unknown): void {
    const nowMs = now();
    if (
      lastFailOpenAlert &&
      nowMs - lastFailOpenAlert.at < FAIL_OPEN_ALERT_INTERVAL_MS
    ) {
      lastFailOpenAlert.suppressed += 1;
      return;
    }
    const suppressed = lastFailOpenAlert?.suppressed ?? 0;
    lastFailOpenAlert = { at: nowMs, suppressed: 0 };
    log.error("[ALERT] email cap fail-open", {
      reason: error instanceof CapStoreTimeoutError ? "timeout" : "error",
      ...(error instanceof Error ? { errorName: error.name } : {}),
      ...(suppressed > 0 ? { suppressed } : {}),
    });
  }

  async function check(recipientHash: string): Promise<CapDecision> {
    const date = new Date(now());
    const day = utcDay(date);
    const hour = `${day}${pad(date.getUTCHours())}`;

    try {
      const [hourly, daily] = await store.incr([
        {
          key: `email:rcpt:1h:${recipientHash}:${hour}`,
          ttlSeconds: HOUR_TTL_SECONDS,
        },
        {
          key: `email:rcpt:1d:${recipientHash}:${day}`,
          ttlSeconds: DAY_TTL_SECONDS,
        },
      ]);
      // A refusal leaves the global count alone, so one abused address cannot
      // eat the whole daily budget.
      if (hourly > RECIPIENT_HOURLY_CAP) {
        return { allowed: false, cap: "recipient:1h" };
      }
      if (daily > RECIPIENT_DAILY_CAP) {
        return { allowed: false, cap: "recipient:1d" };
      }

      const [global] = await store.incr([
        {
          key: `email:global:1d:${day}`,
          ttlSeconds: DAY_TTL_SECONDS,
        },
      ]);
      // INCR is atomic, so each alert fires once a day on a shared store.
      if (global === Math.ceil(dailyCap * ALERT_RATIO)) {
        log.error("[ALERT] email daily cap 80%", { count: global, dailyCap });
      }
      if (global === dailyCap + 1) {
        log.error("[ALERT] email daily cap reached", { dailyCap });
      }
      return global > dailyCap
        ? { allowed: false, cap: "global:1d" }
        : { allowed: true };
    } catch (error) {
      alertFailOpen(error);
      return { allowed: true };
    }
  }

  return { check };
}

export type EmailCaps = ReturnType<typeof createEmailCaps>;
