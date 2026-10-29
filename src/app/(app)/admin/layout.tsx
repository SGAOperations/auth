import { AdminNav } from "@/components/app-shell/admin-nav";
import { TransferCompletedBanner } from "@/components/admin/transfer/transfer-completed-banner";
import { ReauthProvider } from "@/components/reauth-dialog";
import { getRecentCompletion } from "@/lib/admin/transfer-queries";
import { completionBannerCopy } from "@/lib/admin/transfer-view";
import { requireAdmin } from "@/lib/auth/guards";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  await requireAdmin("/admin");
  const completion = await getRecentCompletion();
  return (
    // Every admin has two-factor authentication, so the prompt asks for a code.
    <ReauthProvider twoFactorEnabled>
      <div className="flex flex-col gap-6">
        <AdminNav />
        {completion ? (
          <TransferCompletedBanner
            transferId={completion.id}
            message={completionBannerCopy(completion)}
          />
        ) : null}
        {children}
      </div>
    </ReauthProvider>
  );
}
