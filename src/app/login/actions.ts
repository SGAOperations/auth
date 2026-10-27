"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { consumeRedirect } from "@/lib/redirect/consume";

/**
 * Finishes a sign-in the browser just made against Better Auth: sends the user
 * to the validated redirect target, or `/account`. With no active session it
 * goes back to `/login`, so the redirect cookie is never spent for nobody.
 * Takes no input.
 */
export async function completeSignIn(): Promise<never> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(await consumeRedirect());
}
