import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { PasskeysSection } from "@/components/account/passkeys-section";
import { ChangePasswordForm } from "@/components/account/security/change-password-form";
import { MfaRequiredBanner } from "@/components/account/security/mfa-required-banner";
import { TwoFactorManage } from "@/components/account/security/two-factor-manage";
import { TwoFactorSetup } from "@/components/account/security/two-factor-setup";
import { ReauthProvider } from "@/components/reauth-dialog";
import { loadPasskeys } from "@/lib/account/passkey-list";
import { loadSecurityOverview } from "@/lib/account/security-overview";
import { parseSecurityReason, SECURITY_PATH } from "@/lib/account/security-ui";
import { requireUser } from "@/lib/auth/guards";
import { prisma } from "@/lib/prisma";

export const metadata: Metadata = { title: "Security" };

export default async function SecurityPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser(SECURITY_PATH);
  const overview = await loadSecurityOverview(prisma, user.id);
  if (!overview) {
    redirect(`/login?redirect=${encodeURIComponent(SECURITY_PATH)}`);
  }
  const passkeys = await loadPasskeys(prisma, user.id);
  const reason = parseSecurityReason(await searchParams);

  return (
    <div className="mx-auto flex w-full max-w-2xl flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Security</h1>
        <p className="text-sm text-muted-foreground">
          Manage your password, two-factor authentication and passkeys. These
          settings apply to every SGA tool you sign in to with SGAuth.
        </p>
      </div>
      {overview.mfaRequired ? <MfaRequiredBanner /> : null}
      <ReauthProvider twoFactorEnabled={overview.twoFactorEnabled}>
        <ChangePasswordForm />
        {overview.twoFactorEnabled ? (
          <TwoFactorManage
            email={overview.email}
            isPrimaryAdmin={overview.isPrimaryAdmin}
            canDisable={overview.canDisable}
            backupCodesRemaining={overview.backupCodesRemaining}
          />
        ) : (
          <TwoFactorSetup
            email={overview.email}
            isAdmin={overview.isAdmin}
            mfaRequiredReason={reason === "mfa-required"}
          />
        )}
        <PasskeysSection passkeys={passkeys} isAdmin={overview.isAdmin} />
      </ReauthProvider>
    </div>
  );
}
