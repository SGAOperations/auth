import type { Metadata } from "next";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { twoFactorCookieName } from "@/lib/auth/cookies";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { TwoFactorEnded, TwoFactorForm } from "./two-factor-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Two-factor sign-in" };

// Checks only that the challenge cookie is present, so a direct visit shows the
// ended state instead of a form that cannot work. The verify endpoint checks
// the signature and the challenge row.
export default async function TwoFactorPage() {
  if (await getCurrentUser()) redirect("/login");

  const name = twoFactorCookieName(toAuthSettings(env).cookies);
  if (!(await cookies()).has(name)) return <TwoFactorEnded state="expired" />;

  return <TwoFactorForm />;
}
