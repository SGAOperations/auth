"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { consumeRedirect } from "@/lib/redirect/consume";
import { getOwnSlackMandate } from "@/lib/slack/mandate";

// No session, or a leader the Slack mandate blocks: back to /login so the
// redirect cookie is not spent. /login then says what to do.
export async function completeSignIn(): Promise<never> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  if ((await getOwnSlackMandate(user)).blocked) redirect("/login");
  redirect(await consumeRedirect());
}
