import { AuthShell } from "@/components/auth/auth-shell";
import { PasswordField } from "@/components/auth/password-field";
import {
  TokenActionPage,
  tokenActionMetadata,
} from "@/components/token-action-page";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/policy";
import { prisma } from "@/lib/prisma";
import { loadSetPasswordView } from "@/lib/set-password/consumer";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Set your password");

const FIELDS_ERROR =
  "Use 12 to 128 characters, and make sure both passwords match.";

export default async function SetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token.
  const view = await loadSetPasswordView(await searchParams, {
    prisma,
    now: new Date(),
  });

  if (
    view.state === "invalid" ||
    view.state === "invalid-email" ||
    view.state === "sent"
  ) {
    return <RequestCard state={view.state} />;
  }

  return (
    <TokenActionPage
      title="Set your password"
      description={
        view.state === "ready" ? (
          <>
            Choose a password for <strong>{view.email}</strong>. You&apos;ll use
            it to sign in to every SGA tool.
          </>
        ) : null
      }
      state={view.state}
      token={view.state === "ready" ? view.token : undefined}
      confirmPath="/set-password/confirm"
      actionLabel="Set password and sign in"
      error={view.state === "ready" && view.fieldError ? FIELDS_ERROR : null}
      messages={{
        done:
          view.state !== "ready" && view.signedIn
            ? {
                title: "You're signed in",
                body: "Your password is set. Use it next time you sign in.",
                cta: { label: "Continue", href: "/" },
              }
            : {
                title: "Password set",
                body: "Sign in with your email and new password.",
                cta: { label: "Go to sign in", href: "/" },
              },
      }}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">New password</Label>
        <PasswordField
          id="password"
          name="password"
          showLengthFeedback
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm password</Label>
        <PasswordField
          id="confirmPassword"
          name="confirmPassword"
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
        />
      </div>
    </TokenActionPage>
  );
}

// The states with no token: the request-a-new-link form and its answer. The
// same card shell as TokenActionPage.
function RequestCard({
  state,
}: {
  state: "invalid" | "invalid-email" | "sent";
}) {
  if (state === "sent") {
    return (
      <AuthShell
        title="Check your email"
        description="If that address needs a password, we've sent a link to set one. It expires in 1 hour. Use the newest email if you get more than one."
      />
    );
  }

  return (
    <AuthShell
      title="This link has expired or was already used"
      description="Enter your email and we'll send you a new link."
    >
      <form
        method="post"
        action="/set-password/request"
        className="flex flex-col gap-4"
      >
        <div className="flex flex-col gap-2">
          <Label htmlFor="email">Email</Label>
          <Input
            id="email"
            name="email"
            type="email"
            autoComplete="email"
            required
            maxLength={320}
          />
        </div>
        {state === "invalid-email" ? (
          <p role="alert" className="text-sm text-destructive">
            Enter a valid email address.
          </p>
        ) : null}
        <Button type="submit" className="w-full">
          Email me a new link
        </Button>
      </form>
    </AuthShell>
  );
}
