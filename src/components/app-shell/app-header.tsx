import Link from "next/link";
import { SgaWordmark } from "@/components/sga-wordmark";
import { UserMenu } from "@/components/app-shell/user-menu";
import { displayName, initials } from "@/lib/user-display";

const navLinkClass =
  "inline-flex min-h-11 items-center rounded-md px-3 text-sm font-medium text-muted-foreground hover:bg-muted hover:text-foreground";

export function AppHeader({
  user,
  showAdmin,
}: {
  user: { name: string; preferredName: string | null; email: string };
  showAdmin: boolean;
}) {
  const name = displayName(user);
  return (
    <header className="sticky top-0 z-40 border-b border-glow-faint bg-background/60 backdrop-blur-md">
      <div className="mx-auto flex w-full max-w-5xl items-center gap-2 px-4 sm:gap-4 sm:px-6">
        <span className="inline-flex min-h-11 items-center">
          <SgaWordmark />
        </span>
        <nav aria-label="Main" className="flex flex-1 items-center gap-1">
          <Link href="/" className={navLinkClass}>
            Home
          </Link>
          <Link href="/account" className={navLinkClass}>
            Account
          </Link>
          {showAdmin && (
            <Link href="/admin" className={navLinkClass}>
              Admin
            </Link>
          )}
        </nav>
        <UserMenu
          displayName={name}
          email={user.email}
          initials={initials(name)}
        />
      </div>
    </header>
  );
}
