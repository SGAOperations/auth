"use client";

import { useState } from "react";
import { ConfirmDialog } from "@/components/admin/confirm-dialog";
import { DisabledReason } from "@/components/admin/disabled-reason";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useAdminAction } from "@/hooks/use-admin-action";
import {
  confirmCopy,
  normalizeDraft,
  pendingLine,
  submitBlockReason,
  successToast,
} from "@/lib/admin/email-change-copy";
import { requestEmailChange } from "../actions";

const EMAIL_MAX = 254;

export function EmailChangeForm({
  userId,
  name,
  email,
  legacyEmail,
  pending: request,
  disabledReason,
}: {
  userId: string;
  /** What the confirmation calls the user. */
  name: string;
  email: string;
  legacyEmail: boolean;
  /** The user's open request, or null. */
  pending: { newEmail: string; expiresAt: string } | null;
  /** Why changing the address is off, or null when the admin may. */
  disabledReason: string | null;
}) {
  const { run, pending } = useAdminAction();
  const [draft, setDraft] = useState("");
  // The address is frozen when the dialog opens, so the copy that was shown is
  // the address that is sent, whatever the field holds afterwards.
  const [frozen, setFrozen] = useState("");
  const [open, setOpen] = useState(false);

  const blank = normalizeDraft(draft) === "";
  const blockReason = blank ? null : submitBlockReason(email, draft);
  const locked = disabledReason !== null;
  const dialog = confirmCopy(name, email, frozen);

  function ask(event: React.SyntheticEvent) {
    event.preventDefault();
    if (locked || blank || blockReason !== null) return;
    setFrozen(normalizeDraft(draft));
    setOpen(true);
  }

  async function send() {
    const next = frozen;
    await run(() => requestEmailChange(userId, next), {
      success: successToast(next),
      onSuccess: () => setDraft(""),
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Email</CardTitle>
        <CardDescription>
          Changing the address sends a verification link to the new one. Nothing
          changes until they open it, and the current address keeps working
          until then.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-4">
        {legacyEmail ? (
          <p className="text-sm text-muted-foreground">
            This account has a legacy address. Confirming a northeastern.edu
            address clears that flag.
          </p>
        ) : null}
        {request ? (
          <p
            role="status"
            className="rounded-lg border bg-muted/50 px-3 py-2 text-sm"
          >
            {pendingLine(request, email)}
          </p>
        ) : null}
        <form onSubmit={ask} className="grid max-w-md gap-4" noValidate>
          <div className="grid gap-1.5">
            <span className="text-sm font-medium">Current address</span>
            <p className="break-all text-sm">{email}</p>
          </div>
          <div className="grid gap-1.5">
            <Label htmlFor="email-change-new">New address</Label>
            <Input
              id="email-change-new"
              type="email"
              value={draft}
              maxLength={EMAIL_MAX}
              autoComplete="off"
              disabled={locked || pending}
              onChange={(event) => setDraft(event.target.value)}
            />
          </div>
          <DisabledReason
            reason={disabledReason ?? blockReason}
            busy={pending || blank}
          >
            {(controlProps) => (
              <Button type="submit" {...controlProps}>
                {pending ? "Sending…" : "Send verification link"}
              </Button>
            )}
          </DisabledReason>
        </form>
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={dialog.title}
        description={dialog.description}
        confirmLabel={dialog.label}
        onConfirm={() => void send()}
      />
    </Card>
  );
}
