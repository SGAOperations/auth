import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { getCurrentUser } from "@/lib/auth/current-user";
import { SignUpForm } from "./sign-up-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Create account" };

export default async function SignUpPage() {
  // /login shows the signed-in state, with its way to switch accounts.
  if (await getCurrentUser()) redirect("/login");
  return <SignUpForm />;
}
