// Pure and client-safe: no browser globals, no `server-only`.

export const MOTION_STORAGE_KEY = "sgauth.motion";

export type MotionState = "animate" | "still";

/** Only the exact stored value `"paused"` counts; anything else is ignored. */
export function parseStoredMotion(value: string | null): "paused" | null {
  return value === "paused" ? "paused" : null;
}

/** Reduced motion always wins; otherwise a stored pause stills the backdrop. */
export function resolveMotion({
  prefersReduced,
  stored,
}: {
  prefersReduced: boolean;
  stored: "paused" | null;
}): MotionState {
  if (prefersReduced) return "still";
  return stored === "paused" ? "still" : "animate";
}
