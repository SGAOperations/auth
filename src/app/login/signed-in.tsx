"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { AUTH_COPY } from "@/lib/auth/forms";
import { completeSignIn } from "./actions";

export function SignedIn() {
  const router = useRouter();
  const [switching, setSwitching] = useState(false);
  const [failed, setFailed] = useState(false);

  async function useDifferentAccount() {
    setSwitching(true);
    setFailed(false);
    try {
      const { error } = await authClient.signOut();
      if (error) throw new Error("sign-out failed");
      router.refresh();
    } catch {
      setFailed(true);
    } finally {
      setSwitching(false);
    }
  }

  return (
    <>
      <form action={completeSignIn}>
        <Button type="submit" className="w-full">
          Continue
        </Button>
      </form>
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={switching}
        onClick={useDifferentAccount}
      >
        Use a different account
      </Button>
      {failed ? (
        <p role="alert" className="text-sm text-destructive">
          {AUTH_COPY.unexpected}
        </p>
      ) : null}
    </>
  );
}
