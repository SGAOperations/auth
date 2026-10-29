"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { TransferConfirmAction } from "@/components/admin/transfer/transfer-confirm-action";
import { useReauth } from "@/components/reauth-dialog";
import { Button } from "@/components/ui/button";
import { postTransferAction } from "@/lib/admin/transfer-client";
import {
  REAUTH_DECLINED_COPY,
  transferErrorCopy,
} from "@/lib/admin/transfer-view";

// Accepting asks for a fresh password and code first: the shared re-auth prompt
// opens on the route's REAUTH_REQUIRED and the request is retried once.
export function AcceptTransferPanel({
  transferId,
  fromName,
}: {
  transferId: string;
  fromName: string;
}) {
  const router = useRouter();
  const reauth = useReauth();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function accept() {
    setPending(true);
    setError(null);
    const result = await postTransferAction(
      `/api/sgauth/admin/transfer/${transferId}/accept`,
      {},
      reauth.fetch,
    );
    setPending(false);

    switch (result.kind) {
      case "ok":
        toast.success("Transfer accepted.");
        router.refresh();
        return;
      case "reauth":
        setError(REAUTH_DECLINED_COPY);
        return;
      case "error":
        setError(transferErrorCopy(result.code, result.reason, "recipient"));
        return;
      case "unexpected":
        setError(transferErrorCopy("UNEXPECTED", undefined, "recipient"));
        return;
    }
  }

  return (
    <div className="flex flex-col gap-3">
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="button" onClick={accept} disabled={pending}>
          {pending ? "Accepting…" : "Accept"}
        </Button>
        <TransferConfirmAction
          transferId={transferId}
          action="decline"
          viewer="recipient"
          triggerLabel="Decline"
          title="Decline the transfer?"
          description={`${fromName} stays Primary Admin and will be notified.`}
          keepLabel="Not yet"
          confirmLabel="Decline transfer"
          successMessage="Transfer declined."
        />
      </div>
    </div>
  );
}
