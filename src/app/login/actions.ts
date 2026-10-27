"use server";

import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { consumeRedirect } from "@/lib/redirect/consume";

// No session: back to /login so the redirect cookie is not spent.
export async function completeSignIn(): Promise<never> {
  const user = await getCurrentUser();
  if (!user) redirect("/login");
  redirect(await consumeRedirect());
}
