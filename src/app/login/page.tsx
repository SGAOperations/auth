import type { Metadata } from "next";
import { AuthShell } from "@/components/auth/auth-shell";
import { getCurrentUser } from "@/lib/auth/current-user";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { LoginForm } from "./login-form";
import { SignedIn } from "./signed-in";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in" };

export default async function LoginPage() {
  const user = await getCurrentUser();

  if (user) {
    return (
      <AuthShell
        title="You're signed in"
        description={`Signed in as ${user.email}.`}
        requiresJs
      >
        <SignedIn />
      </AuthShell>
    );
  }

  return <LoginForm emailCodeEnabled={toAuthSettings(env).emailOtp.enabled} />;
}
