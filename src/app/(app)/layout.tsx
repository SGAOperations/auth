import { redirect } from "next/navigation";
import { AppHeader } from "@/components/app-shell/app-header";
import { getCurrentUser } from "@/lib/auth/current-user";
import { canAccessAdmin } from "@/lib/auth/guards";

export default async function AppLayout({
  children,
}: Readonly<{ children: React.ReactNode }>) {
  // A fallback only: layouts are skipped on soft navigation, so every page
  // also calls requireUser/requireAdmin with its own path.
  const user = await getCurrentUser();
  if (!user) redirect("/login");

  return (
    <>
      <a
        href="#main"
        className="sr-only focus:not-sr-only focus:absolute focus:left-2 focus:top-2 focus:z-50 focus:rounded-md focus:bg-background focus:px-3 focus:py-2"
      >
        Skip to main content
      </a>
      <AppHeader user={user} showAdmin={canAccessAdmin(user)} />
      <main
        id="main"
        className="mx-auto w-full max-w-5xl flex-1 px-4 py-6 sm:px-6"
      >
        {children}
      </main>
    </>
  );
}
