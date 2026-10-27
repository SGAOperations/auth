import type { BetterAuthOptions } from "better-auth";

const DAY_SECONDS = 24 * 60 * 60;

/** Sliding window: a session unused for this long is invalid. */
export const SESSION_EXPIRES_IN_SECONDS = 30 * DAY_SECONDS;

/** The window is pushed out at most once per this interval. */
export const SESSION_UPDATE_AGE_SECONDS = DAY_SECONDS;

/**
 * Absolute cap from `createdAt`. The 90 days is repeated in the
 * `clamp_session_expiry` trigger migration and in the `absoluteExpiresAt`
 * column default, so change all three together.
 */
export const SESSION_ABSOLUTE_MAX_AGE_MS = 90 * DAY_SECONDS * 1000;

export const SESSION_OPTIONS = {
  expiresIn: SESSION_EXPIRES_IN_SECONDS,
  updateAge: SESSION_UPDATE_AGE_SECONDS,
  // No session_data cookie: revocation must be immediate. Mirrored in
  // cookies.test.ts.
  cookieCache: { enabled: false },
  // Lets the adapter write the cap on insert and return it on the session
  // object. `freshAge` is deliberately unset: it gates Better Auth's own fresh
  // session endpoints, and re-auth is tracked by `lastReauthAt` instead.
  additionalFields: {
    absoluteExpiresAt: { type: "date", required: false, input: false },
  },
} satisfies NonNullable<BetterAuthOptions["session"]>;

/**
 * The window a new session starts with. `expiresAt` is clamped to the cap so
 * Better Auth's own `expiresAt < now` check enforces the 90 days on every
 * endpoint. The `clamp_session_expiry` trigger keeps it clamped on every later
 * write.
 */
export function initialSessionWindow(input: {
  createdAt: Date;
  expiresAt: Date;
}): { absoluteExpiresAt: Date; expiresAt: Date } {
  const absoluteExpiresAt = new Date(
    input.createdAt.getTime() + SESSION_ABSOLUTE_MAX_AGE_MS,
  );
  const expiresAt = new Date(
    Math.min(input.expiresAt.getTime(), absoluteExpiresAt.getTime()),
  );
  return { absoluteExpiresAt, expiresAt };
}
