"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

const GENERIC_FAILURE = "Couldn't sign out everywhere. Try again.";
const REAUTH_REQUIRED =
  "For your security, sign out and sign in again, then retry.";

async function isReauthRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body: unknown = await response.json();
    if (typeof body !== "object" || body === null) return false;
    const { error, code } = body as { error?: unknown; code?: unknown };
    return error === "REAUTH_REQUIRED" || code === "REAUTH_REQUIRED";
  } catch {
    return false;
  }
}

export function SignOutEverywhereDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const [pending, setPending] = useState(false);

  async function confirm() {
    setPending(true);
    try {
      const response = await fetch("/api/sgauth/sessions/revoke-all", {
        method: "POST",
      });
      if (response.ok) {
        window.location.replace("/login");
        return;
      }
      toast.error(
        (await isReauthRequired(response)) ? REAUTH_REQUIRED : GENERIC_FAILURE,
      );
    } catch {
      toast.error(GENERIC_FAILURE);
    }
    setPending(false);
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent showCloseButton={false}>
        <DialogHeader>
          <DialogTitle>Sign out everywhere?</DialogTitle>
          <DialogDescription>
            This signs you out of SGAuth and every SGA tool on all of your
            devices, including this one.
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <DialogClose render={<Button variant="outline" />}>
            Cancel
          </DialogClose>
          <Button variant="destructive" disabled={pending} onClick={confirm}>
            {pending ? "Signing out…" : "Sign out everywhere"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
