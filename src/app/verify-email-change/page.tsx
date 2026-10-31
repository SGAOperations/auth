import {
  TokenActionPage,
  tokenActionMetadata,
  type TokenActionPageProps,
} from "@/components/token-action-page";
import { emailChangeService } from "@/lib/email-change/server";
import { loadEmailChangeView } from "@/lib/email-change/view";

export const dynamic = "force-dynamic";

export const metadata = tokenActionMetadata("Confirm your new email");

const SIGN_IN = { label: "Go to sign in", href: "/login" };

const UNAVAILABLE = {
  title: "We couldn't complete this change",
  body: "This address can't be used for this account. Contact an SGA administrator.",
};

const EXPIRED = {
  title: "This link has expired",
  body: "Ask an SGA administrator to send a new one.",
};

// Public on purpose: the new mailbox's owner has no session, so this sits
// outside the (app) layout, which requires one.
export default async function VerifyEmailChangePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  // Read-only: a GET never consumes the token.
  const view = await loadEmailChangeView(await searchParams, (token) =>
    emailChangeService.peekEmailChange(token),
  );

  // Expired and unavailable are this page's own outcomes, shown through the
  // shared page's `invalid` slot with their own copy.
  const state: TokenActionPageProps["state"] =
    view.state === "expired" || view.state === "unavailable"
      ? "invalid"
      : view.state;
  const invalid =
    view.state === "expired"
      ? EXPIRED
      : view.state === "unavailable"
        ? UNAVAILABLE
        : {
            title: "This link isn't valid",
            body: "It may have been replaced by a newer request. Use the most recent email you received, or ask an SGA administrator.",
          };

  return (
    <TokenActionPage
      title="Confirm your new email"
      description={
        view.state === "ready" ? (
          <>
            Your SGA account&apos;s sign-in email will change to{" "}
            <strong>{view.newEmail}</strong>. Your old address will stop working
            for sign-in, and you&apos;ll be signed out everywhere.
          </>
        ) : undefined
      }
      state={state}
      token={view.state === "ready" ? view.token : undefined}
      confirmPath="/verify-email-change/confirm"
      actionLabel="Confirm email change"
      error={
        view.state === "ready" && view.error
          ? "Something went wrong with that form. Try again."
          : undefined
      }
      messages={{
        done: {
          title: "Email updated",
          body: "Sign in with your new email address from now on.",
          cta: SIGN_IN,
        },
        invalid,
        used: {
          title: "Already confirmed",
          body: "This email change has already been applied.",
          cta: SIGN_IN,
        },
      }}
    />
  );
}
