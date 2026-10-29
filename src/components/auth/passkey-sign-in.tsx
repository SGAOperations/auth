"use client";

import { KeyRound } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { Button } from "@/components/ui/button";
import { authClient } from "@/lib/auth/client";
import { PASSKEY_COPY, mapPasskeySignInError } from "@/lib/auth/passkey-ui";
import { usePasskeySupport } from "@/lib/auth/use-passkey-support";

interface PasskeySignInProps {
  /** Runs once a passkey has signed the person in. Redirects. */
  onSignedIn: () => Promise<void>;
}

/**
 * "Sign in with a passkey", and the browser's autofill entry for one on the
 * email field (which carries `autoComplete="username webauthn"`). Renders
 * nothing where WebAuthn is missing.
 */
export function PasskeySignIn({ onSignedIn }: PasskeySignInProps) {
  const supported = usePasskeySupport();
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async (autoFill: boolean) => {
      const result = await authClient.signIn.passkey({ autoFill });
      if (result.error) {
        const outcome = mapPasskeySignInError(result.error);
        if (outcome.kind === "message") setError(outcome.message);
        return;
      }
      await onSignedIn();
    },
    [onSignedIn],
  );

  useEffect(() => {
    if (!supported) return;
    let active = true;
    void (async () => {
      const available =
        await PublicKeyCredential.isConditionalMediationAvailable?.();
      if (active && available) await run(true);
    })().catch(() => {
      // Autofill is a convenience: a failure leaves the button to work.
    });
    return () => {
      active = false;
    };
  }, [supported, run]);

  if (!supported) return null;

  async function onClick() {
    setError(null);
    setPending(true);
    try {
      await run(false);
    } catch {
      setError(PASSKEY_COPY.signInFailed);
    } finally {
      setPending(false);
    }
  }

  return (
    <>
      <div
        role="separator"
        className="flex items-center gap-3 text-xs text-muted-foreground uppercase"
      >
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
        or
        <span aria-hidden="true" className="h-px flex-1 bg-border" />
      </div>
      <Button
        type="button"
        variant="outline"
        className="w-full"
        disabled={pending}
        onClick={() => void onClick()}
      >
        <KeyRound aria-hidden="true" />
        {pending ? PASSKEY_COPY.signInPending : PASSKEY_COPY.signInButton}
      </Button>
      {error ? (
        <p role="alert" className="text-sm text-destructive">
          {error}
        </p>
      ) : null}
    </>
  );
}
