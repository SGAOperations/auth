// Pure on purpose: state in, state out, with `now` injected. No `server-only`
// and no Prisma import, so tests can step through days of lock levels without
// a database or a clock. The server module (lockout.ts) applies these to rows.
// Policy and rationale: docs/LOCKOUT.md.

const MINUTE_MS = 60 * 1000;
const HOUR_MS = 60 * MINUTE_MS;

/** Failures inside the window that trigger a lock. */
export const FAILURE_THRESHOLD = 5;
export const FAILURE_WINDOW_MS = 15 * MINUTE_MS;
/** The first lock; each later one doubles. */
export const BASE_LOCK_MS = 15 * MINUTE_MS;
/** Locks are never permanent. */
export const MAX_LOCK_MS = 24 * HOUR_MS;
/** A lock level resets after this long with no failure and no active lock. */
export const LEVEL_DECAY_MS = 24 * HOUR_MS;
/** A known device that trips its own counter is paused this long. */
export const DEVICE_LOCK_MS = 15 * MINUTE_MS;

export interface AccountLockState {
  failedCount: number;
  windowStartedAt: Date;
  lockedUntil: Date | null;
  /** Locks taken since the last decay. The next lock lasts `lockDurationMs(lockLevel)`. */
  lockLevel: number;
  lastFailedAt: Date | null;
}

export interface DeviceLockState {
  failedCount: number;
  windowStartedAt: Date | null;
  lockedUntil: Date | null;
}

export interface LockEvent {
  until: Date;
  /** The level after this lock, so the first lock is level 1. */
  level: number;
  durationMs: number;
}

/** 15 min at level 0, doubling per level, capped at 24 h. */
export function lockDurationMs(level: number): number {
  return Math.min(BASE_LOCK_MS * 2 ** level, MAX_LOCK_MS);
}

export function isLocked(
  state: { lockedUntil: Date | null },
  now: Date,
): boolean {
  return state.lockedUntil !== null && state.lockedUntil > now;
}

/**
 * A failure opens a new window when nothing is counted yet (so the first
 * failure after a lock or a success starts its own window) or the current one
 * is older than 15 minutes.
 */
function opensNewWindow(
  {
    failedCount,
    windowStartedAt,
  }: Pick<AccountLockState, "failedCount"> & {
    windowStartedAt: Date | null;
  },
  now: Date,
): boolean {
  return (
    failedCount === 0 ||
    windowStartedAt === null ||
    now.getTime() - windowStartedAt.getTime() > FAILURE_WINDOW_MS
  );
}

/** The newest of the account's last failure and its last lock's end. */
function lastActivity(state: AccountLockState): Date | null {
  const times = [state.lastFailedAt, state.lockedUntil].filter(
    (time): time is Date => time !== null,
  );
  return times.length === 0
    ? null
    : new Date(Math.max(...times.map((time) => time.getTime())));
}

/**
 * Counts one failed password. A failure that lands while the account is
 * already locked changes nothing: the lock is in force, and counting it would
 * let a burst of parallel guesses stretch the window.
 */
export function applyAccountFailure(
  state: AccountLockState,
  now: Date,
): { state: AccountLockState; locked: LockEvent | null } {
  if (isLocked(state, now)) return { state, locked: null };

  const last = lastActivity(state);
  const decayed =
    last !== null && now.getTime() - last.getTime() >= LEVEL_DECAY_MS;
  let lockLevel = decayed ? 0 : state.lockLevel;

  const restart = opensNewWindow(state, now);
  let failedCount = restart ? 1 : state.failedCount + 1;
  let windowStartedAt = restart ? now : state.windowStartedAt;
  let lockedUntil = state.lockedUntil;
  let locked: LockEvent | null = null;

  if (failedCount >= FAILURE_THRESHOLD) {
    const durationMs = lockDurationMs(lockLevel);
    lockedUntil = new Date(now.getTime() + durationMs);
    lockLevel += 1;
    locked = { until: lockedUntil, level: lockLevel, durationMs };
    failedCount = 0;
    windowStartedAt = now;
  }

  return {
    state: {
      failedCount,
      windowStartedAt,
      lockedUntil,
      lockLevel,
      lastFailedAt: now,
    },
    locked,
  };
}

/**
 * A successful login resets the counter but never clears an active lock: a
 * sign-in from a known device shows the owner is present, not that an
 * attacker stopped.
 */
export function applyAccountSuccess(
  state: AccountLockState,
  now: Date,
): AccountLockState {
  return { ...state, failedCount: 0, windowStartedAt: now };
}

/**
 * Lifts the lock (unlock link, password reset, admin). The level is kept, so a
 * continuing attack still escalates; 24 h of quiet still decays it.
 */
export function applyAccountUnlock(
  state: AccountLockState,
  now: Date,
): AccountLockState {
  return {
    ...state,
    lockedUntil: null,
    failedCount: 0,
    windowStartedAt: now,
  };
}

/**
 * Counts one failed password from a known device, against the device's own
 * counter. Same window and threshold as the account; the lock is flat and
 * sends no email.
 */
export function applyDeviceFailure(
  device: DeviceLockState,
  now: Date,
): { state: DeviceLockState; locked: boolean } {
  if (isLocked(device, now)) return { state: device, locked: false };

  const restart = opensNewWindow(device, now);
  const failedCount = restart ? 1 : device.failedCount + 1;
  const windowStartedAt = restart ? now : device.windowStartedAt;

  if (failedCount >= FAILURE_THRESHOLD) {
    return {
      state: {
        failedCount: 0,
        windowStartedAt: now,
        lockedUntil: new Date(now.getTime() + DEVICE_LOCK_MS),
      },
      locked: true,
    };
  }
  return {
    state: { failedCount, windowStartedAt, lockedUntil: device.lockedUntil },
    locked: false,
  };
}

export function applyDeviceSuccess(
  device: DeviceLockState,
  now: Date,
): DeviceLockState {
  return { ...device, failedCount: 0, windowStartedAt: now };
}
