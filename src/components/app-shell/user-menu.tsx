"use client";

import { useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { SignOutEverywhereDialog } from "@/components/app-shell/sign-out-everywhere-dialog";

export function UserMenu({
  displayName,
  email,
  initials,
}: {
  displayName: string;
  email: string;
  initials: string;
}) {
  const [signingOut, setSigningOut] = useState(false);
  const [everywhereOpen, setEverywhereOpen] = useState(false);

  async function signOut() {
    setSigningOut(true);
    try {
      const response = await fetch("/api/auth/sign-out", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      if (response.ok) {
        // A full reload drops the client cache.
        window.location.replace("/login");
        return;
      }
    } catch {
      // Falls through to the failure toast.
    }
    toast.error("Couldn't sign you out. Check your connection and try again.");
    setSigningOut(false);
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={
            <Button
              variant="ghost"
              className="min-h-11 gap-2 px-2"
              aria-label={`Account menu for ${displayName}`}
            />
          }
        >
          <span
            aria-hidden="true"
            className="flex size-7 items-center justify-center rounded-full bg-brand text-xs font-semibold text-brand-foreground"
          >
            {initials}
          </span>
          <span className="hidden max-w-40 truncate sm:inline">
            {displayName}
          </span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-64 min-w-56">
          <DropdownMenuGroup>
            <DropdownMenuLabel className="flex flex-col gap-0.5">
              <span className="truncate text-sm text-foreground">
                {displayName}
              </span>
              <span className="truncate text-muted-foreground">{email}</span>
            </DropdownMenuLabel>
          </DropdownMenuGroup>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={signingOut}
            closeOnClick={false}
            onClick={signOut}
          >
            Sign out
          </DropdownMenuItem>
          <DropdownMenuItem onClick={() => setEverywhereOpen(true)}>
            Sign out everywhere…
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
      <SignOutEverywhereDialog
        open={everywhereOpen}
        onOpenChange={setEverywhereOpen}
      />
    </>
  );
}
