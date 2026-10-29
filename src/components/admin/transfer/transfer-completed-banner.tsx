"use client";

import { useSyncExternalStore } from "react";
import { Button } from "@/components/ui/button";
import { BANNER_STORAGE_PREFIX } from "@/lib/admin/transfer-view";

// Dismissal is per transfer and per browser. Storage can be unavailable or
// throw (private windows, blocked site data), and the banner then simply shows.

const listeners = new Set<() => void>();

function subscribe(listener: () => void) {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function readDismissed(key: string): boolean {
  try {
    return window.localStorage.getItem(key) === "1";
  } catch {
    return false;
  }
}

function writeDismissed(key: string) {
  try {
    window.localStorage.setItem(key, "1");
  } catch {
    // Nothing to remember it with: the banner returns on the next load.
  }
}

export function TransferCompletedBanner({
  transferId,
  message,
}: {
  transferId: string;
  message: string;
}) {
  const key = `${BANNER_STORAGE_PREFIX}${transferId}`;
  // The server snapshot is "dismissed" so the banner never flashes for someone
  // who already closed it. It appears once the client has read storage.
  const dismissed = useSyncExternalStore(
    subscribe,
    () => readDismissed(key),
    () => true,
  );

  if (dismissed) return null;

  return (
    <div
      role="status"
      className="flex items-start justify-between gap-3 rounded-lg border bg-muted/50 p-3 text-sm"
    >
      <p>{message}</p>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => {
          writeDismissed(key);
          for (const listener of listeners) listener();
        }}
      >
        Dismiss
      </Button>
    </div>
  );
}
