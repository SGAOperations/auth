import {
  TokenActionPage,
  tokenActionMetadata,
} from "@/components/token-action-page";
import { prisma } from "@/lib/prisma";
import { loadUnlockView } from "@/lib/auth/unlock";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Unlock your account");

export default async function UnlockPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token.
  const view = await loadUnlockView(await searchParams, prisma);

  return (
    <TokenActionPage
      title="Unlock your account"
      description="Sign-in to your SGA account was paused after several failed attempts. Unlock it to sign in again now."
      state={view.state}
      token={view.state === "ready" ? view.token : undefined}
      confirmPath="/unlock/confirm"
      actionLabel="Unlock account"
      messages={{
        done: {
          title: "Account unlocked",
          body: "You can sign in again. If you didn't make those attempts, reset your password.",
          cta: { label: "Continue to sign in", href: "/" },
        },
      }}
    />
  );
}
