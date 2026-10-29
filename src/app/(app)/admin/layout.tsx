import { AdminNav } from "@/components/app-shell/admin-nav";
import { ReauthProvider } from "@/components/reauth-dialog";
import { requireAdmin } from "@/lib/auth/guards";

export default async function AdminLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  const user = await requireAdmin("/admin");
  return (
    <ReauthProvider twoFactorEnabled={user.twoFactorEnabled}>
      <div className="flex flex-col gap-6">
        <AdminNav />
        {children}
      </div>
    </ReauthProvider>
  );
}
