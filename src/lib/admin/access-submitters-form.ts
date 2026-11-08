import { MAX_SUBMITTER_POSITIONS } from "@/lib/access-submitters-input";
import type { SubmitterActionResult } from "@/app/(app)/admin/access-submitters/actions";

type SubmitterFailureCode = Extract<
  SubmitterActionResult,
  { ok: false }
>["code"];

// Pure and client-safe: no database, no `server-only`.

export interface SubmitterOption {
  key: string;
  name: string;
  category: string | null;
}

const UNCATEGORIZED = "Uncategorized";

/** Groups options by category, keeping input order. */
export function groupByCategory(
  options: readonly SubmitterOption[],
): [string, SubmitterOption[]][] {
  const groups = new Map<string, SubmitterOption[]>();
  for (const option of options) {
    const category = option.category ?? UNCATEGORIZED;
    groups.set(category, [...(groups.get(category) ?? []), option]);
  }
  return [...groups.entries()];
}

/** Options whose name (any case) or key contains the query. */
export function filterOptions(
  options: readonly SubmitterOption[],
  query: string,
): SubmitterOption[] {
  const needle = query.trim().toLowerCase();
  if (needle === "") return [...options];
  return options.filter(
    (option) =>
      option.name.toLowerCase().includes(needle) || option.key.includes(needle),
  );
}

/**
 * Returns a new selection. Checking a key that is already present, or checking
 * one at the cap, returns `selected` unchanged.
 */
export function toggleKey(
  selected: readonly string[],
  key: string,
  checked: boolean,
): readonly string[] {
  if (!checked) return selected.filter((entry) => entry !== key);
  if (selected.includes(key) || selected.length >= MAX_SUBMITTER_POSITIONS) {
    return selected;
  }
  return [...selected, key];
}

// Keyed over the action's failure codes, so a new code fails `tsc` until it has
// copy. UNKNOWN_POSITION has its own inline alert instead of a toast.
export const SUBMITTER_FAILURE_COPY: Record<
  Exclude<SubmitterFailureCode, "UNKNOWN_POSITION">,
  string
> = {
  FORBIDDEN: "You don't have permission to do that.",
  RATE_LIMITED: "Too many changes. Try again in a minute.",
  INVALID_INPUT: "This list couldn't be saved. Refresh the page and try again.",
};

export const SUBMITTER_UNEXPECTED_COPY = "Something went wrong. Try again.";
