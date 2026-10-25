import {
  TokenActionPage,
  tokenActionMetadata,
} from "@/components/token-action-page";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { prisma } from "@/lib/prisma";
import { loadVerifyEmailView } from "@/lib/token-links/verify-email";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Verify your email");

export default async function VerifyEmailPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token (AUTH-T103).
  const view = await loadVerifyEmailView(await searchParams, {
    secret: toAuthSettings(env).secret,
    db: prisma,
  });

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
      messages={{
        done: {
          title: "Email verified",
          body: "Your SGA account is ready.",
          cta: { label: "Continue to sign in", href: "/" },
        },
      }}
    />
  );
}
