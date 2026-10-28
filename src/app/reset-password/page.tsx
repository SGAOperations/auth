import {
  TokenActionPage,
  tokenActionMetadata,
  type TokenActionPageProps,
} from "@/components/token-action-page";
import { PasswordField } from "@/components/auth/password-field";
import { Label } from "@/components/ui/label";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "@/lib/auth/policy";
import { RESET_PASSWORD_TOKEN_TTL_SECONDS } from "@/lib/auth/password-reset";
import { prisma } from "@/lib/prisma";
import { loadResetPasswordView } from "@/lib/token-links/reset-password";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Choose a new password");

const FIELDS_ERROR =
  "Use 12 to 128 characters, and make sure both passwords match.";

const messages: TokenActionPageProps["messages"] = {
  done: {
    title: "Password reset",
    body: "Your password has been reset, and you've been signed out everywhere. Sign in with your new password.",
    cta: { label: "Go to sign in", href: "/" },
  },
  invalid: {
    title: "This reset link isn't valid",
    body: `It may have expired or already been used. Reset links work once and last ${RESET_PASSWORD_TOKEN_TTL_SECONDS / 3600} hour. Request a new one from the sign-in page.`,
    cta: { label: "Go to sign in", href: "/" },
  },
  used: {
    title: "This reset link was already used",
    body: "Reset links work once. Request a new one from the sign-in page.",
    cta: { label: "Go to sign in", href: "/" },
  },
};

export default async function ResetPasswordPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token.
  const view = await loadResetPasswordView(await searchParams, {
    db: prisma,
    now: new Date(),
  });

  return (
    <TokenActionPage
      title="Choose a new password"
      description={`Enter a new password for your SGA account. It must be ${PASSWORD_MIN_LENGTH} to ${PASSWORD_MAX_LENGTH} characters.`}
      state={view.state}
      token={view.state === "ready" ? view.token : undefined}
      confirmPath="/reset-password/confirm"
      actionLabel="Reset password"
      error={view.state === "ready" && view.fieldError ? FIELDS_ERROR : null}
      messages={messages}
    >
      <div className="flex flex-col gap-2">
        <Label htmlFor="newPassword">New password</Label>
        <PasswordField
          id="newPassword"
          name="newPassword"
          showLengthFeedback
          autoComplete="new-password"
          required
          minLength={PASSWORD_MIN_LENGTH}
          maxLength={PASSWORD_MAX_LENGTH}
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="confirmPassword">Confirm new password</Label>
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
