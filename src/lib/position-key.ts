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

/**
 * A key proposed from a position name: ASCII slug, at most 64 characters.
 * Empty when fewer than 2 characters remain.
 */
export function suggestPositionKey(name: string): string {
  const slug = name
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/&/g, " and ")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, POSITION_KEY_MAX)
    .replace(/-+$/, "");
  return slug.length < POSITION_KEY_MIN ? "" : slug;
}

/**
 * Lower-cases `A-Z` and drops every other character outside `[a-z0-9-]`.
 * `rejected` is true when anything was dropped.
 */
export function sanitizeKeyInput(raw: string): {
  value: string;
  rejected: boolean;
} {
  const lowered = raw.replace(/[A-Z]/g, (letter) => letter.toLowerCase());
  const value = lowered.replace(/[^a-z0-9-]/g, "");
  return { value, rejected: value.length !== lowered.length };
}

export type PositionKeyIssue =
  | "TOO_SHORT"
  | "TOO_LONG"
  | "EDGE_HYPHEN"
  | "DOUBLE_HYPHEN"
  | "INVALID_CHARS";

/** The first reason `key` fails `positionKeySchema`, or null when it passes. */
export function positionKeyIssue(key: string): PositionKeyIssue | null {
  if (/[^a-z0-9-]/.test(key)) return "INVALID_CHARS";
  if (key.length < POSITION_KEY_MIN) return "TOO_SHORT";
  if (key.length > POSITION_KEY_MAX) return "TOO_LONG";
  if (key.startsWith("-") || key.endsWith("-")) return "EDGE_HYPHEN";
  if (key.includes("--")) return "DOUBLE_HYPHEN";
  return null;
}

/** The first moment a key retired at `retiredAt` can be used again. */
export function keyReusableOn(retiredAt: Date): Date {
  return new Date(retiredAt.getTime() + KEY_RETIREMENT_DAYS * MS_PER_DAY);
}

/** A key retired exactly `KEY_RETIREMENT_DAYS` ago is reusable. */
export function isKeyRetirementActive(retiredAt: Date, now: Date): boolean {
  const windowStart = now.getTime() - KEY_RETIREMENT_DAYS * MS_PER_DAY;
  return retiredAt.getTime() > windowStart;
}
