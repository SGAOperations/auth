"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { AUTH_COPY, mapRequestError } from "@/lib/auth/forms";

type ResendState = "idle" | "sending" | "sent" | "rate-limited" | "unexpected";

// Asks for a new verification link. The endpoint is rate limited and answers
// the same for every address, so "sent" never says whether one went out.
export function ResendVerification({ email }: { email: string }) {
  const [state, setState] = useState<ResendState>("idle");

  async function resend() {
    setState("sending");
    try {
      const { error } = await authClient.sendVerificationEmail({ email });
      setState(error ? mapRequestError(error) : "sent");
    } catch {
      setState("unexpected");
    }
  }

  return (
    <div className="flex flex-col gap-2">
      <Button
        type="button"
        variant="secondary"
        className="w-full"
        disabled={state === "sending"}
        onClick={resend}
      >
        {state === "sending" ? "Sending…" : "Send a new link"}
      </Button>
      {state === "sent" ? (
        <p role="status" className="text-sm text-muted-foreground">
          {AUTH_COPY.resendSent}
        </p>
      ) : null}
      {state === "rate-limited" ? (
        <p role="alert" className="text-sm text-destructive">
          {AUTH_COPY.resendRateLimited}
        </p>
      ) : null}
      {state === "unexpected" ? (
        <p role="alert" className="text-sm text-destructive">
          {AUTH_COPY.unexpected}
        </p>
      ) : null}
    </div>
  );
}
