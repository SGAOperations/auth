"use client";

import { useEffect, useId, useState } from "react";
import { toast } from "sonner";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { keyReusableOn } from "@/lib/position-key";
import {
  formatPositionDate,
  positionErrorMessage,
  positionFailureToast,
} from "@/lib/position-view";
import { deletePosition, deletePositionPreflight } from "./positions-api";

export interface DeletablePosition {
  id: string;
  key: string;
  name: string;
}

type Preflight = { holderCount: number } | "failed" | null;

function holderLine(holderCount: number): string {
  if (holderCount === 0) return "No one holds this position.";
  const who =
    holderCount === 1
      ? "1 person holds this position."
      : `${holderCount} people hold this position.`;
  return `${who} They lose it the next time any SGA product checks their session.`;
}

// Mounted only while the dialog is open, so every open starts from a fresh
// preflight and an empty confirm input.
function DeleteBody({
  position,
  onClose,
  onDeleted,
  onStale,
}: {
  position: DeletablePosition;
  onClose: () => void;
  onDeleted: () => void;
  onStale: () => void;
}) {
  const inputId = useId();
  const [preflight, setPreflight] = useState<Preflight>(null);
  const [typed, setTyped] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [now] = useState(() => new Date());

  useEffect(() => {
    let active = true;
    void deletePositionPreflight(position.id).then((result) => {
      if (!active) return;
      setPreflight(
        result.ok ? { holderCount: result.data.holderCount } : "failed",
      );
    });
    return () => {
      active = false;
    };
  }, [position.id]);

  const ready = preflight !== null && preflight !== "failed";
  const retiredUntil = formatPositionDate(keyReusableOn(now));

  async function confirm() {
    setPending(true);
    setError(null);
    const result = await deletePosition(position.id, typed);
    setPending(false);
    if (result.ok) {
      toast.success(
        `Deleted ${position.name}. Its key is retired until ${retiredUntil}.`,
      );
      onDeleted();
      return;
    }
    if (result.code === "CONFIRM_KEY_MISMATCH") {
      setError(positionErrorMessage(result.code));
      return;
    }
    const failure = positionFailureToast(result);
    toast.error(failure.message);
    if (failure.refresh) {
      onClose();
      onStale();
    }
  }

  return (
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>Delete {position.name}?</AlertDialogTitle>
        <AlertDialogDescription render={<div />}>
          {preflight === null ? (
            <p>Checking holders…</p>
          ) : preflight === "failed" ? (
            <p>
              Couldn&apos;t check who holds this position. Close this dialog and
              try again.
            </p>
          ) : (
            <div className="flex flex-col gap-2">
              <p>{holderLine(preflight.holderCount)}</p>
              <p>
                The key <code className="font-mono">{position.key}</code> will
                be retired until {retiredUntil}. Assignment history is kept.
              </p>
            </div>
          )}
        </AlertDialogDescription>
      </AlertDialogHeader>
      <div className="flex flex-col gap-2">
        <Label htmlFor={inputId}>
          Type <code className="font-mono">{position.key}</code> to confirm
        </Label>
        <Input
          id={inputId}
          value={typed}
          onChange={(event) => setTyped(event.target.value)}
          className="font-mono"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
          disabled={!ready}
        />
        {error ? (
          <p role="alert" className="text-sm text-destructive">
            {error}
          </p>
        ) : null}
      </div>
      <AlertDialogFooter>
        <AlertDialogCancel>Cancel</AlertDialogCancel>
        <AlertDialogAction
          variant="destructive"
          disabled={!ready || typed !== position.key || pending}
          onClick={confirm}
        >
          {pending ? "Deleting…" : "Delete position"}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  );
}

/**
 * The typed-key delete confirmation. `onDeleted` runs after a successful
 * delete and `onStale` after a failure that means the page is out of date.
 */
export function DeletePositionDialog({
  position,
  onOpenChange,
  onDeleted,
  onStale,
}: {
  position: DeletablePosition | null;
  onOpenChange: (open: boolean) => void;
  onDeleted: () => void;
  onStale: () => void;
}) {
  return (
    <AlertDialog open={position !== null} onOpenChange={onOpenChange}>
      {position ? (
        <DeleteBody
          key={position.id}
          position={position}
          onClose={() => onOpenChange(false)}
          onDeleted={() => {
            onOpenChange(false);
            onDeleted();
          }}
          onStale={onStale}
        />
      ) : null}
    </AlertDialog>
  );
}
