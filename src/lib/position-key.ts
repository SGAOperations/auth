import { z } from "zod";

// Pure and client-safe: no database, no `server-only`.

export const POSITION_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const POSITION_KEY_MIN = 2;
export const POSITION_KEY_MAX = 64;
export const POSITION_NAME_MIN = 2;
export const POSITION_NAME_MAX = 100;
export const MAX_ACTIVE_POSITIONS_PER_USER = 50;
export const KEY_RETIREMENT_DAYS = 365;

const MS_PER_DAY = 24 * 60 * 60 * 1000;

// Keys are never trimmed or lower-cased silently: "VP-Finance" is rejected.
export const positionKeySchema = z
  .string()
  .min(POSITION_KEY_MIN)
  .max(POSITION_KEY_MAX)
  .regex(POSITION_KEY_PATTERN);

export const positionNameSchema = z
  .string()
  .trim()
  .min(POSITION_NAME_MIN)
  .max(POSITION_NAME_MAX);

/** A key retired exactly `KEY_RETIREMENT_DAYS` ago is reusable. */
export function isKeyRetirementActive(retiredAt: Date, now: Date): boolean {
  const windowStart = now.getTime() - KEY_RETIREMENT_DAYS * MS_PER_DAY;
  return retiredAt.getTime() > windowStart;
}
