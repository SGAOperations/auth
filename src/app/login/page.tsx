import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { getOwnSlackMandate } from "@/lib/slack/mandate";
import { slackResultMessage } from "@/lib/slack/result";
import { LoginForm } from "./login-form";
import { SignedIn } from "./signed-in";
import { SlackRequired } from "./slack-required";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<{ slack?: string | string[] }>;
}) {
  const user = await getCurrentUser();

  if (user) {
    const result = slackResultMessage((await searchParams).slack);
    const mandate = await getOwnSlackMandate(user);
    if (mandate.blocked) {
      return (
        <AuthShell
          title="Allow Slack title updates to continue"
          description={`Signed in as ${user.email}.`}
          requiresJs
        >
          <SlackRequired linked={mandate.linked} result={result} />
        </AuthShell>
      );
    }
    return (
      <AuthShell
        title="You're signed in"
        description={`Signed in as ${user.email}.`}
        requiresJs
      >
        <SignedIn
          status={
            result?.result === "title_updates_allowed"
              ? result.message
              : undefined
          }
        />
      </AuthShell>
    );
  }

  return <LoginForm emailCodeEnabled={toAuthSettings(env).emailOtp.enabled} />;
}
