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
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { useAdminAction } from "@/hooks/use-admin-action";
import {
  deactivateUser,
  grantAdmin,
  reactivateUser,
  resendInvite,
  revokeAdmin,
  unlockUser,
} from "../actions";

type Pending = "admin" | "deactivate" | null;

/** Each reason is the text that explains a disabled control, or null when it is enabled. */
export interface AccountReasons {
  admin: string | null;
  deactivate: string | null;
  reactivate: string | null;
  unlock: string | null;
  resendInvite: string | null;
}

export function AccountActions({
  userId,
  name,
  email,
  isAdmin,
  status,
  reasons,
}: {
  userId: string;
  /** What the confirmations call the user. */
  name: string;
  email: string;
  isAdmin: boolean;
  status: "ACTIVE" | "DEACTIVATED";
  reasons: AccountReasons;
}) {
  const { run, pending } = useAdminAction();
  const [confirm, setConfirm] = useState<Pending>(null);
  const deactivated = status === "DEACTIVATED";

  const confirmCopy = {
    admin: isAdmin
      ? {
          title: `Remove admin access from ${name}?`,
          description: "They'll no longer be able to manage SGAuth.",
          label: "Remove admin access",
          destructive: true,
        }
      : {
          title: `Grant admin access to ${name}?`,
          description:
            "They'll be able to manage users, positions, and products.",
          label: "Grant admin access",
          destructive: false,
        },
    deactivate: {
      title: `Deactivate ${name}?`,
      description:
        "They'll be signed out everywhere immediately and can't sign in until reactivated.",
      label: "Deactivate",
      destructive: true,
    },
  } as const;
  const dialog = confirm ? confirmCopy[confirm] : null;

  function confirmed() {
    if (confirm === "admin") {
      void run(() => (isAdmin ? revokeAdmin(userId) : grantAdmin(userId)), {
        success: isAdmin
          ? `${name} is no longer an admin.`
          : `${name} is now an admin.`,
      });
    } else if (confirm === "deactivate") {
      void run(() => deactivateUser(userId), {
        success: `${name} deactivated.`,
      });
    }
  }

  const switchId = `admin-switch-${userId}`;

  return (
    <Card>
      <CardHeader>
        <CardTitle>Access</CardTitle>
        <CardDescription>
          Admin access, account status, lockout and invites.
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        <DisabledReason reason={reasons.admin} busy={pending}>
          {({ disabled, "aria-describedby": describedBy }) => (
            <div className="flex items-center gap-3">
              <Switch
                id={switchId}
                checked={isAdmin}
                disabled={disabled}
                aria-describedby={describedBy}
                // Controlled: the page's data changes it, after the dialog.
                onCheckedChange={() => setConfirm("admin")}
              />
              <Label htmlFor={switchId}>Administrator</Label>
            </div>
          )}
        </DisabledReason>

        <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
          {deactivated ? (
            <DisabledReason reason={reasons.reactivate} busy={pending}>
              {(controlProps) => (
                <Button
                  type="button"
                  variant="outline"
                  {...controlProps}
                  onClick={() =>
                    run(() => reactivateUser(userId), {
                      success: `${name} reactivated.`,
                    })
                  }
                >
                  Reactivate
                </Button>
              )}
            </DisabledReason>
          ) : (
            <DisabledReason reason={reasons.deactivate} busy={pending}>
              {(controlProps) => (
                <Button
                  type="button"
                  variant="destructive"
                  {...controlProps}
                  onClick={() => setConfirm("deactivate")}
                >
                  Deactivate
                </Button>
              )}
            </DisabledReason>
          )}

          <DisabledReason reason={reasons.unlock} busy={pending}>
            {(controlProps) => (
              <Button
                type="button"
                variant="outline"
                {...controlProps}
                onClick={() =>
                  run(() => unlockUser(userId), {
                    success: "Account unlocked.",
                  })
                }
              >
                Unlock
              </Button>
            )}
          </DisabledReason>

          <DisabledReason reason={reasons.resendInvite} busy={pending}>
            {(controlProps) => (
              <Button
                type="button"
                variant="outline"
                {...controlProps}
                onClick={() =>
                  run(() => resendInvite(userId), {
                    success: (result) =>
                      result.email === undefined || result.email === "sent"
                        ? `Invite sent to ${email}.`
                        : "Invite created, but the email couldn't be sent. Try again shortly.",
                  })
                }
              >
                Resend invite
              </Button>
            )}
          </DisabledReason>
        </div>
      </CardContent>

      <ConfirmDialog
        open={dialog !== null}
        onOpenChange={(open) => {
          if (!open) setConfirm(null);
        }}
        title={dialog?.title ?? ""}
        description={dialog?.description ?? ""}
        confirmLabel={dialog?.label ?? "Confirm"}
        destructive={dialog?.destructive}
        onConfirm={confirmed}
      />
    </Card>
  );
}
