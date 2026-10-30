"use client";

import { useCallback, useSyncExternalStore } from "react";
import {
  MOTION_STORAGE_KEY,
  parseStoredMotion,
  resolveMotion,
  type MotionState,
} from "@/lib/backdrop/motion";

const REDUCED_QUERY = "(prefers-reduced-motion: reduce)";

const listeners = new Set<() => void>();

function notify() {
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  const media = window.matchMedia(REDUCED_QUERY);
  const onStorage = (event: StorageEvent) => {
    if (event.key === null || event.key === MOTION_STORAGE_KEY) listener();
  };
  media.addEventListener("change", listener);
  window.addEventListener("storage", onStorage);
  return () => {
    listeners.delete(listener);
    media.removeEventListener("change", listener);
    window.removeEventListener("storage", onStorage);
  };
}

// Holds the choice when storage is blocked, so the button still works until reload.
let memoryPaused = false;

function readStored(): "paused" | null {
  try {
    const stored = parseStoredMotion(
      window.localStorage.getItem(MOTION_STORAGE_KEY),
    );
    if (stored) return stored;
  } catch {
    // Fall through to the in-memory choice.
  }
  return memoryPaused ? "paused" : null;
}

// A primitive snapshot, so useSyncExternalStore compares it by value.
type Snapshot = "reduced" | "paused" | "animate";

function getSnapshot(): Snapshot {
  if (window.matchMedia(REDUCED_QUERY).matches) return "reduced";
  return readStored() === "paused" ? "paused" : "animate";
}

function getServerSnapshot(): Snapshot {
  return "animate";
}

export function useMotionPreference(): {
  motion: MotionState;
  prefersReduced: boolean;
  paused: boolean;
  setPaused: (paused: boolean) => void;
} {
  const snapshot = useSyncExternalStore(
    subscribe,
    getSnapshot,
    getServerSnapshot,
  );
  const prefersReduced = snapshot === "reduced";
  const paused = snapshot === "paused";

  const setPaused = useCallback((next: boolean) => {
    memoryPaused = next;
    try {
      if (next) window.localStorage.setItem(MOTION_STORAGE_KEY, "paused");
      else window.localStorage.removeItem(MOTION_STORAGE_KEY);
    } catch {
      // Storage can be blocked (private mode); memoryPaused carries the choice.
    }
    notify();
  }, []);

  return {
    motion: resolveMotion({
      prefersReduced,
      stored: paused ? "paused" : null,
    }),
    prefersReduced,
    paused,
    setPaused,
  };
}
