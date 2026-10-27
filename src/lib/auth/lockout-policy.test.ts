import { describe, expect, it } from "vitest";
import {
  BASE_LOCK_MS,
  DEVICE_LOCK_MS,
  FAILURE_THRESHOLD,
  FAILURE_WINDOW_MS,
  LEVEL_DECAY_MS,
  MAX_LOCK_MS,
  applyAccountFailure,
  applyAccountSuccess,
  applyAccountUnlock,
  applyDeviceFailure,
  applyDeviceSuccess,
  isLocked,
  lockDurationMs,
  type AccountLockState,
  type DeviceLockState,
  type LockEvent,
} from "@/lib/auth/lockout-policy";

const MIN = 60 * 1000;
const HOUR = 60 * MIN;
const START = new Date("2026-01-01T00:00:00Z");

const at = (ms: number) => new Date(START.getTime() + ms);

function fresh(now = START): AccountLockState {
  return {
    failedCount: 0,
    windowStartedAt: now,
    lockedUntil: null,
    lockLevel: 0,
    lastFailedAt: null,
  };
}

/** Fails once a second from `from` until the account locks. */
function failUntilLocked(state: AccountLockState, from: Date) {
  let current = state;
  let locked: LockEvent | null = null;
  let now = from;
  for (let i = 0; i < FAILURE_THRESHOLD; i++) {
    now = new Date(from.getTime() + i * 1000);
    ({ state: current, locked } = applyAccountFailure(current, now));
  }
  return { state: current, locked, now };
}

describe("lockDurationMs", () => {
  it("doubles from 15 minutes and caps at 24 hours", () => {
    const hours = [0, 1, 2, 3, 4, 5, 6, 7, 8, 20].map(
      (level) => lockDurationMs(level) / HOUR,
    );
    expect(hours).toEqual([0.25, 0.5, 1, 2, 4, 8, 16, 24, 24, 24]);
  });
});

describe("account failures", () => {
  it("does not lock on 4 failures and locks on the 5th at level 1", () => {
    let state = fresh();
    for (let i = 0; i < 4; i++) {
      const result = applyAccountFailure(state, at(i * 1000));
      expect(result.locked).toBeNull();
      state = result.state;
    }
    expect(state.failedCount).toBe(4);
    expect(isLocked(state, at(4000))).toBe(false);

    const fifth = applyAccountFailure(state, at(4000));
    expect(fifth.locked).toEqual({
      until: at(4000 + BASE_LOCK_MS),
      level: 1,
      durationMs: BASE_LOCK_MS,
    });
    expect(fifth.state.lockedUntil).toEqual(at(4000 + BASE_LOCK_MS));
    expect(fifth.state.failedCount).toBe(0);
    expect(fifth.state.lockLevel).toBe(1);
  });

  it("never locks when failures are spread over more than the window", () => {
    let state = fresh();
    // One failure every 4 minutes for a day: never 5 inside 15 minutes.
    for (let i = 0; i < 360; i++) {
      const result = applyAccountFailure(state, at(i * 4 * MIN));
      expect(result.locked).toBeNull();
      state = result.state;
    }
    expect(state.lockedUntil).toBeNull();
  });

  it("restarts the window once it is older than 15 minutes", () => {
    let state = fresh();
    for (let i = 0; i < 4; i++) {
      state = applyAccountFailure(state, at(i * 1000)).state;
    }
    const late = applyAccountFailure(state, at(FAILURE_WINDOW_MS + 5000));
    expect(late.locked).toBeNull();
    expect(late.state.failedCount).toBe(1);
    expect(late.state.windowStartedAt).toEqual(at(FAILURE_WINDOW_MS + 5000));
  });

  it("escalates 15 m, 30 m, 1 h, 2 h, 4 h, 8 h, 16 h, then 24 h twice", () => {
    let state = fresh();
    let now = START;
    const durations: number[] = [];
    for (let i = 0; i < 9; i++) {
      const round = failUntilLocked(state, now);
      expect(round.locked).not.toBeNull();
      durations.push(round.locked!.durationMs / HOUR);
      state = round.state;
      // The next attempt comes the moment the lock expires.
      now = round.state.lockedUntil!;
    }
    expect(durations).toEqual([0.25, 0.5, 1, 2, 4, 8, 16, 24, 24]);
    expect(durations.every((hours) => hours * HOUR <= MAX_LOCK_MS)).toBe(true);
  });

  it("decays the level after 24 hours clean following a lock", () => {
    let state = fresh();
    const first = failUntilLocked(state, START);
    const second = failUntilLocked(first.state, first.state.lockedUntil!);
    expect(second.locked!.level).toBe(2);
    state = second.state;

    const quiet = new Date(state.lockedUntil!.getTime() + LEVEL_DECAY_MS);
    const third = failUntilLocked(state, quiet);
    expect(third.locked).toMatchObject({ level: 1, durationMs: BASE_LOCK_MS });
  });

  it("keeps the level when the next lock comes just short of 24 hours", () => {
    const first = failUntilLocked(fresh(), START);
    const almost = new Date(
      first.state.lockedUntil!.getTime() + LEVEL_DECAY_MS - 1000,
    );
    const second = failUntilLocked(first.state, almost);
    expect(second.locked).toMatchObject({ level: 2 });
  });

  it("ignores a failure that lands while the account is locked", () => {
    const { state, now } = failUntilLocked(fresh(), START);
    const result = applyAccountFailure(state, new Date(now.getTime() + 1000));
    expect(result.locked).toBeNull();
    expect(result.state).toBe(state);
  });
});

describe("account success and unlock", () => {
  it("success resets the count but leaves an active lock", () => {
    const { state, now } = failUntilLocked(fresh(), START);
    const later = new Date(now.getTime() + MIN);
    const next = applyAccountSuccess(state, later);
    expect(next.failedCount).toBe(0);
    expect(next.windowStartedAt).toEqual(later);
    expect(next.lockedUntil).toEqual(state.lockedUntil);
    expect(isLocked(next, later)).toBe(true);
  });

  it("success clears a partial count", () => {
    let state = fresh();
    for (let i = 0; i < 3; i++) {
      state = applyAccountFailure(state, at(i * 1000)).state;
    }
    expect(applyAccountSuccess(state, at(10_000)).failedCount).toBe(0);
  });

  it("unlock clears the lock and keeps the level", () => {
    const { state, now } = failUntilLocked(fresh(), START);
    const later = new Date(now.getTime() + MIN);
    const unlocked = applyAccountUnlock(state, later);
    expect(unlocked.lockedUntil).toBeNull();
    expect(unlocked.failedCount).toBe(0);
    expect(unlocked.lockLevel).toBe(1);
    expect(isLocked(unlocked, later)).toBe(false);

    // A continuing attack escalates from the kept level.
    const again = failUntilLocked(unlocked, later);
    expect(again.locked).toMatchObject({
      level: 2,
      durationMs: 2 * BASE_LOCK_MS,
    });
  });
});

describe("device failures", () => {
  const fresh: DeviceLockState = {
    failedCount: 0,
    windowStartedAt: null,
    lockedUntil: null,
  };

  it("locks for a flat 15 minutes at 5 failures and never escalates", () => {
    let device = fresh;
    let now = START;
    for (let round = 0; round < 3; round++) {
      let locked = false;
      for (let i = 0; i < FAILURE_THRESHOLD; i++) {
        now = new Date(now.getTime() + 1000);
        const result = applyDeviceFailure(device, now);
        device = result.state;
        locked = result.locked;
      }
      expect(locked).toBe(true);
      expect(device.lockedUntil).toEqual(
        new Date(now.getTime() + DEVICE_LOCK_MS),
      );
      expect(device.failedCount).toBe(0);
      now = device.lockedUntil!;
    }
  });

  it("does not lock on 4 failures", () => {
    let device = fresh;
    for (let i = 0; i < 4; i++) {
      const result = applyDeviceFailure(device, at(i * 1000));
      expect(result.locked).toBe(false);
      device = result.state;
    }
    expect(isLocked(device, at(5000))).toBe(false);
  });

  it("does not lock when failures are spread over more than the window", () => {
    let device = fresh;
    for (let i = 0; i < 100; i++) {
      device = applyDeviceFailure(device, at(i * 4 * MIN)).state;
    }
    expect(device.lockedUntil).toBeNull();
  });

  it("ignores a failure while locked and resets on success", () => {
    let device = fresh;
    let now = START;
    for (let i = 0; i < FAILURE_THRESHOLD; i++) {
      now = new Date(now.getTime() + 1000);
      device = applyDeviceFailure(device, now).state;
    }
    const during = applyDeviceFailure(device, new Date(now.getTime() + 1000));
    expect(during.state).toBe(device);
    expect(during.locked).toBe(false);

    const ok = applyDeviceSuccess(
      { failedCount: 3, windowStartedAt: START, lockedUntil: null },
      at(1000),
    );
    expect(ok.failedCount).toBe(0);
  });
});
