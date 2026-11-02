"use client";

import { useState, type FormEvent } from "react";
import { DisabledReason } from "@/components/admin/disabled-reason";
import {
  AlertDialog,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
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
import { canSubmitDelete, deleteDialogCopy } from "@/lib/admin/delete-user";
import { emailConfirmed } from "@/lib/admin/transfer-view";
import { deleteUser } from "../actions";

/** What the dialog confirmed, frozen when it opened so a refresh can't change it. */
interface Target {
  name: string;
  email: string;
}

export function DeleteUser({
  userId,
  name,
  email,
  reason,
}: {
  userId: string;
  /** What the confirmation calls the user. */
  name: string;
  email: string;
  /** The text that explains a disabled control, or null when it is enabled. */
  reason: string | null;
}) {
  const { run, pending } = useAdminAction();
  const [target, setTarget] = useState<Target | null>(null);
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState("");
  const [touched, setTouched] = useState(false);

  const frozen = target ?? { name, email };
  const copy = deleteDialogCopy(frozen.name);
  const submittable = canSubmitDelete(typed, frozen.email, pending);
  const mismatch =
    touched && typed !== "" && !emailConfirmed(typed, frozen.email);

  function openDialog() {
    setTarget({ name, email });
    setTyped("");
    setTouched(false);
    setOpen(true);
  }

  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!submittable) return;
    // Close first, so the re-auth prompt never stacks on this dialog.
    setOpen(false);
    void run(() => deleteUser(userId), { success: `${frozen.name} deleted.` });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle>Delete account</CardTitle>
        <CardDescription>
          Permanently remove this user&apos;s personal data. Their ID is kept so
          product records still resolve.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <DisabledReason reason={reason} busy={pending}>
          {(controlProps) => (
            <Button
              type="button"
              variant="destructive"
              {...controlProps}
              onClick={openDialog}
            >
              Delete account…
            </Button>
          )}
        </DisabledReason>
      </CardContent>

      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogContent>
          <form onSubmit={submit} className="contents">
            <AlertDialogHeader>
              <AlertDialogTitle>{copy.title}</AlertDialogTitle>
              <AlertDialogDescription>
                This can&apos;t be undone. SGAuth will:
              </AlertDialogDescription>
            </AlertDialogHeader>
            <ul className="list-disc pl-5 text-sm text-muted-foreground">
              {copy.consequences.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <div className="flex flex-col gap-3">
              <Label
                htmlFor="delete-user-email"
                className="leading-normal font-normal"
              >
                Type{" "}
                <strong className="font-semibold break-all">
                  {frozen.email}
                </strong>{" "}
                to confirm.
              </Label>
              <Input
                id="delete-user-email"
                type="text"
                value={typed}
                onChange={(event) => setTyped(event.target.value)}
                onBlur={() => setTouched(true)}
                autoComplete="off"
                spellCheck={false}
                aria-invalid={mismatch}
                aria-describedby={
                  mismatch ? "delete-user-email-error" : undefined
                }
              />
              {mismatch ? (
                <p
                  id="delete-user-email-error"
                  role="alert"
                  className="text-sm text-destructive"
                >
                  This doesn&apos;t match the user&apos;s email exactly.
                </p>
              ) : null}
            </div>
            <AlertDialogFooter>
              <AlertDialogCancel>Cancel</AlertDialogCancel>
              <Button
                type="submit"
                variant="destructive"
                disabled={!submittable}
              >
                {copy.label}
              </Button>
            </AlertDialogFooter>
          </form>
        </AlertDialogContent>
      </AlertDialog>
    </Card>
  );
}
