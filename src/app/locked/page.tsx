import type { Metadata } from "next";
import Link from "next/link";
import { AuthShell } from "@/components/auth/auth-shell";
import { buttonVariants } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export const metadata: Metadata = {
  title: "Account locked",
  robots: { index: false, follow: false },
};

// Static: no token, database or session, so it reveals nothing about any account.
export default function LockedPage() {
  return (
    <AuthShell title="Your account is temporarily locked">
      <p className="text-sm text-muted-foreground">
        After several incorrect password attempts, we lock the account for a
        while to protect it. Locks start at 15 minutes and can grow to 24 hours
        if the attempts continue.
      </p>
      <p className="text-sm text-muted-foreground">
        We&apos;ve emailed the account&apos;s address a link that unlocks it
        right away. Resetting your password also clears the lock.
      </p>
      <p className="text-sm text-muted-foreground">
        Didn&apos;t try to sign in? Someone may be guessing your password.
        Resetting it keeps your account safe.
      </p>
      <Link href="/forgot-password" className={cn(buttonVariants(), "w-full")}>
        Reset password
      </Link>
      <Link
        href="/login"
        className={cn(buttonVariants({ variant: "ghost" }), "w-full")}
      >
        Back to sign in
      </Link>
    </AuthShell>
  );
}
