import { vi } from "vitest";

export type FakeClock = {
  now(): Date;
  advance(ms: number): void;
  set(at: Date | string): void;
  restore(): void;
};

/**
 * Freezes `Date` at `start`. Only `Date` is faked: faking setTimeout or
 * setImmediate hangs pg and Prisma I/O. The database's own `now()` is not
 * affected.
 */
export function useFakeClock(
  start: Date | string = "2026-01-01T00:00:00Z",
): FakeClock {
  vi.useFakeTimers({ toFake: ["Date"], now: new Date(start) });
  return {
    now: () => new Date(),
    advance: (ms) => {
      vi.setSystemTime(Date.now() + ms);
    },
    set: (at) => {
      vi.setSystemTime(new Date(at));
    },
    restore: () => {
      vi.useRealTimers();
    },
  };
}
