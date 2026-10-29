"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { BackupCodesPanel } from "@/components/account/security/backup-codes-panel";
import { PasswordActionForm } from "@/components/account/security/password-action-form";
import { useReauth } from "@/components/reauth-dialog";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import {
  backupCodesStatus,
  parseRegenerateResponse,
  postSecurity,
  type SecurityError,
} from "@/lib/account/security-ui";

interface TwoFactorManageProps {
  email: string;
  isPrimaryAdmin: boolean;
  canDisable: boolean;
  backupCodesRemaining: number | null;
}

const GENERIC_ERROR: SecurityError = {
  message: "Something went wrong. Try again.",
};

export function TwoFactorManage({
  email,
  isPrimaryAdmin,
  canDisable,
  backupCodesRemaining,
}: TwoFactorManageProps) {
  const router = useRouter();
  const reauth = useReauth();
  const [newCodes, setNewCodes] = useState<string[] | null>(null);
  const status = backupCodesStatus(backupCodesRemaining);

  async function regenerate(password: string): Promise<SecurityError | null> {
    const result = await postSecurity(
      reauth.fetch,
      "/api/auth/two-factor/generate-backup-codes",
      { password },
    );
    if (!result.ok) return result.error;
    const codes = parseRegenerateResponse(result.body);
    if (!codes) return GENERIC_ERROR;
    setNewCodes(codes);
    return null;
  }

  async function disable(password: string): Promise<SecurityError | null> {
    const result = await postSecurity(
      reauth.fetch,
      "/api/auth/two-factor/disable",
      { password },
    );
    if (!result.ok) return result.error;
    router.refresh();
    return null;
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          Two-factor authentication
          <Badge>On</Badge>
        </CardTitle>
        <CardDescription>
          {status
            ? status.summary
            : "Your account asks for a second step at sign-in."}
        </CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {newCodes ? (
          <BackupCodesPanel
            codes={newCodes}
            email={email}
            mode="regenerated"
            onDone={() => {
              setNewCodes(null);
              router.refresh();
            }}
          />
        ) : (
          <>
            {status?.warning ? (
              <p className="text-sm font-medium text-destructive">
                {status.warning}
              </p>
            ) : null}

            <section className="flex flex-col gap-3">
              <h3 className="text-base font-medium">Backup codes</h3>
              <PasswordActionForm
                submitLabel="Generate new backup codes"
                pendingLabel="Generating…"
                notice="Your current backup codes will stop working."
                onSubmit={regenerate}
              />
            </section>

            <section className="flex flex-col gap-3 border-t pt-6">
              <h3 className="text-base font-medium">Turn off</h3>
              {canDisable ? (
                <PasswordActionForm
                  submitLabel="Turn off two-factor authentication"
                  pendingLabel="Turning off…"
                  variant="destructive"
                  notice="You'll sign in with just your password."
                  onSubmit={disable}
                />
              ) : (
                <p className="text-sm text-muted-foreground">
                  {isPrimaryAdmin
                    ? "Two-factor authentication can't be turned off while you are the Primary Admin."
                    : "Two-factor authentication can't be turned off while you are an admin."}
                </p>
              )}
            </section>
          </>
        )}
      </CardContent>
    </Card>
  );
}
