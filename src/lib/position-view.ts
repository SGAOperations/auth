// Pure and client-safe: no database, no `server-only`.

export const UNCATEGORIZED = "Uncategorized";

const POSITION_DATE_FORMAT = new Intl.DateTimeFormat("en-US", {
  dateStyle: "medium",
  timeZone: "America/New_York",
});

/** The same string on the server and in the browser. */
export function formatPositionDate(date: Date): string {
  return POSITION_DATE_FORMAT.format(date);
}

export interface PositionGroup<T> {
  category: string;
  positions: T[];
}

/**
 * Groups by category, sorted by name, with "Uncategorized" last. Rows inside a
 * group are sorted by name.
 */
export function groupPositionsByCategory<
  T extends { name: string; category: string | null },
>(rows: readonly T[]): PositionGroup<T>[] {
  const groups = new Map<string | null, T[]>();
  for (const row of rows) {
    const bucket = groups.get(row.category);
    if (bucket) bucket.push(row);
    else groups.set(row.category, [row]);
  }
  const named = [...groups.entries()]
    .filter((entry): entry is [string, T[]] => entry[0] !== null)
    .sort(([a], [b]) => a.localeCompare(b));
  const uncategorized = groups.get(null);
  const ordered: [string, T[]][] = uncategorized
    ? [...named, [UNCATEGORIZED, uncategorized]]
    : named;
  return ordered.map(([category, positions]) => ({
    category,
    positions: [...positions].sort((a, b) => a.name.localeCompare(b.name)),
  }));
}

export const GENERIC_ERROR_MESSAGE = "Something went wrong. Try again.";

const ERROR_MESSAGES: Readonly<Record<string, string>> = {
  KEY_TAKEN: "Another active position already uses this key.",
  KEY_RETIRED:
    "This key belonged to a deleted position and can't be reused until 365 days after it was deleted.",
  INVALID_KEY:
    "2–64 characters: lowercase letters, numbers, and single hyphens between words.",
  INVALID_INPUT: "Check what you entered and try again.",
  CONFIRM_KEY_MISMATCH: "The key you typed doesn't match.",
  POSITION_NOT_FOUND: "This position no longer exists.",
  POSITION_DELETED: "This position has been deleted.",
  POSITION_LIMIT: "This person already holds the maximum number of positions.",
  MANAGER_CYCLE:
    "That position already reports to this one, so this would make a loop. Pick another.",
  MANAGER_NOT_FOUND: "That position was deleted. Pick another.",
};

/** User-facing copy for an API error code, with a generic fallback. */
export function positionErrorMessage(code: string): string {
  return ERROR_MESSAGES[code] ?? GENERIC_ERROR_MESSAGE;
}

/**
 * The toast for a failed request. `refresh` is true when the page is stale: a
 * lapsed session (the guard redirects) or a position that is gone (the list
 * re-renders without it).
 */
export function positionFailureToast(failure: {
  status: number;
  code: string;
}): {
  message: string;
  refresh: boolean;
} {
  if (failure.status === 401) {
    return { message: "Your session has ended. Sign in again.", refresh: true };
  }
  if (failure.status === 403) {
    return { message: "You no longer have admin access.", refresh: false };
  }
  if (
    failure.status === 404 ||
    failure.code === "POSITION_NOT_FOUND" ||
    failure.code === "POSITION_DELETED"
  ) {
    return { message: "This position no longer exists.", refresh: true };
  }
  return { message: positionErrorMessage(failure.code), refresh: false };
}

/** Codes that belong on the key field rather than in a toast. */
export function isKeyErrorCode(code: string): boolean {
  return (
    code === "KEY_TAKEN" || code === "KEY_RETIRED" || code === "INVALID_KEY"
  );
}

/** Codes that belong under the "Reports to" picker rather than in a toast. */
export function isManagerErrorCode(code: string): boolean {
  return code === "MANAGER_CYCLE" || code === "MANAGER_NOT_FOUND";
}

export const KEY_ISSUE_MESSAGES = {
  TOO_SHORT: "Use at least 2 characters.",
  TOO_LONG: "Use at most 64 characters.",
  EDGE_HYPHEN: "Can't start or end with a hyphen.",
  DOUBLE_HYPHEN: "Use a single hyphen between words.",
  INVALID_CHARS: "Only lowercase letters, numbers, and hyphens are allowed.",
} as const;
