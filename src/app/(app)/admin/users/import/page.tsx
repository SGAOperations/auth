import type { Metadata } from "next";
import { ReauthProvider } from "@/components/reauth-dialog";
import { requireAdmin } from "@/lib/auth/guards";
import { ImportForm } from "./import-form";

export const metadata: Metadata = { title: "Import users" };

const PATH = "/admin/users/import";

export default async function ImportUsersPage() {
  // The layout is skipped on soft navigation, so the page checks again.
  const user = await requireAdmin(PATH);
  return (
    <div className="flex flex-col gap-6">
      <div className="flex flex-col gap-1">
        <h1 className="text-2xl font-semibold tracking-tight">Import users</h1>
        <p className="text-muted-foreground">
          Upload a CSV to create password-less accounts and assign positions.
          Existing accounts keep their name and current positions; an import
          only adds.
        </p>
      </div>
      <ReauthProvider twoFactorEnabled={user.twoFactorEnabled}>
        <ImportForm />
      </ReauthProvider>
    </div>
  );
}
