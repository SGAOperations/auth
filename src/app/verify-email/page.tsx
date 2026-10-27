import {
  TokenActionPage,
  tokenActionMetadata,
  type TokenActionPageProps,
} from "@/components/token-action-page";
import { VERIFICATION_TOKEN_TTL_SECONDS } from "@/lib/auth/policy";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { loadVerifyEmailView } from "@/lib/token-links/verify-email";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Verify your email");

const HOURS = VERIFICATION_TOKEN_TTL_SECONDS / 3600;

const messages: TokenActionPageProps["messages"] = {
  done: {
    title: "Email verified",
    body: "Your SGA account is ready.",
    cta: { label: "Continue to sign in", href: "/" },
  },
  used: {
    title: "Email already verified",
    body: "This address is already verified. Sign in to continue.",
    cta: { label: "Go to sign in", href: "/" },
  },
  invalid: {
    title: "This link isn't valid",
    body: "It may have been copied incorrectly. Sign in to get a new verification link.",
    cta: { label: "Go to sign in", href: "/" },
  },
  rate: {
    title: "Too many requests",
    body: "You've made several requests recently. Try again later.",
  },
  sent: {
    title: "Check your inbox",
    body: `If this address still needs verifying, we've sent a new link. It expires in ${HOURS} hours.`,
  },
};

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token.
  const view = await loadVerifyEmailView(await searchParams, {
    secret: toAuthSettings(env).secret,
    db: prisma,
  });

  // An expired link offers a resend, a form that POSTs to its own route.
  if (view.state === "expired") {
    return (
      <TokenActionPage
        title="This link has expired"
        description={`Verification links work for ${HOURS} hours. We can send a new one to the address it was sent to.`}
        state="ready"
        token={view.token}
        confirmPath="/verify-email/resend"
        actionLabel="Send a new link"
        messages={messages}
      />
    );
  }

  return (
    <TokenActionPage
      title="Verify your email"
      description={
        view.state === "ready" ? (
          <>
            Confirm <strong>{view.email}</strong> to finish setting up your SGA
            account.
          </>
        ) : null
      }
      state={view.state}
      token={view.state === "ready" ? view.token : undefined}
      confirmPath="/verify-email/confirm"
      actionLabel="Verify email"
      messages={messages}
    />
  );
}
