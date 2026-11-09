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
import { useAdminAction } from "@/hooks/use-admin-action";
import { stopSlackTitleUpdates } from "../actions";

const dateFormat = new Intl.DateTimeFormat("en-US", { dateStyle: "medium" });

/**
 * The admin's control over a user's Slack title consent. The user can grant it
 * from their own account page, but only an administrator can withdraw it here.
 */
export function SlackTitleAccess({
  userId,
  name,
  grantedAt,
  reason,
}: {
  userId: string;
  /** What the confirmation calls the user. */
  name: string;
  /** When the user allowed title updates, or null when they have not. */
  grantedAt: Date | null;
  /** The text that explains why the stop control is disabled, or null. */
  reason: string | null;
}) {
  const { run, pending } = useAdminAction();
  const [open, setOpen] = useState(false);

  return (
    <Card id="slack-title">
      <CardHeader>
        <CardTitle>Slack title</CardTitle>
        <CardDescription>
          Whether SGAuth may update this user&apos;s Slack title. The user
          grants it from their account page; only an administrator can stop it.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3 text-sm">
        {grantedAt ? (
          <>
            <p>
              Allowed on {dateFormat.format(grantedAt)}. SGAuth keeps their
              Slack title matched to their leadership positions.
            </p>
            <DisabledReason reason={reason} busy={pending}>
              {(controlProps) => (
                <Button
                  type="button"
                  variant="outline"
                  className="w-fit"
                  {...controlProps}
                  onClick={() => setOpen(true)}
                >
                  Stop title updates
                </Button>
              )}
            </DisabledReason>
          </>
        ) : (
          <p className="text-muted-foreground">
            This user hasn&apos;t allowed SGAuth to update their Slack title.
          </p>
        )}
      </CardContent>
      <ConfirmDialog
        open={open}
        onOpenChange={setOpen}
        title={`Stop Slack title updates for ${name}?`}
        description="SGAuth stops updating their Slack title and revokes its access at Slack. Their title stays as it is. If they hold a leadership position while the Slack mandate is on, they are blocked from SGA products until they allow title updates again."
        confirmLabel="Stop title updates"
        destructive
        onConfirm={() => {
          setOpen(false);
          void run(() => stopSlackTitleUpdates(userId), {
            success: `${name} no longer allows SGAuth to update their Slack title.`,
          });
        }}
      />
    </Card>
  );
}
