"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { useReauth } from "@/components/reauth-dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { postTransferAction } from "@/lib/admin/transfer-client";
import {
  REAUTH_DECLINED_COPY,
  transferErrorCopy,
  type TransferViewer,
} from "@/lib/admin/transfer-view";

interface TransferConfirmActionProps {
  transferId: string;
  action: "cancel" | "decline";
  viewer: TransferViewer;
  triggerLabel: string;
  title: string;
  description: string;
  keepLabel: string;
  confirmLabel: string;
  successMessage: string;
}

// Cancel and decline share one shape: confirm in a dialog, then call the route.
// The dialog closes before the call so a re-authentication prompt, if the
// session is stale, is the only modal open. The outcome is a toast.
export function TransferConfirmAction({
  transferId,
  action,
  viewer,
  triggerLabel,
  title,
  description,
  keepLabel,
  confirmLabel,
  successMessage,
}: TransferConfirmActionProps) {
  const router = useRouter();
  const reauth = useReauth();
  const [open, setOpen] = useState(false);
  const [pending, setPending] = useState(false);

  async function confirm() {
    setOpen(false);
    setPending(true);
    const result = await postTransferAction(
      `/api/sgauth/admin/transfer/${transferId}/${action}`,
      {},
      reauth.fetch,
    );
    setPending(false);

    if (result.kind === "ok") {
      toast.success(successMessage);
      router.refresh();
    } else if (result.kind === "reauth") {
      toast.error(REAUTH_DECLINED_COPY);
    } else if (result.kind === "error") {
      toast.error(transferErrorCopy(result.code, result.reason, viewer));
      // The transfer may have moved on: show where it stands now.
      router.refresh();
    } else {
      toast.error(transferErrorCopy("UNEXPECTED", undefined, viewer));
    }
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={<Button variant="destructive" disabled={pending} />}
      >
        {pending ? "Working…" : triggerLabel}
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>{title}</AlertDialogTitle>
          <AlertDialogDescription>{description}</AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>{keepLabel}</AlertDialogCancel>
          <AlertDialogAction variant="destructive" onClick={confirm}>
            {confirmLabel}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
