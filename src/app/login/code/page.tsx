import type { Metadata } from "next";
import { notFound } from "next/navigation";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { CodeForm } from "./code-form";

export const dynamic = "force-dynamic";

export const metadata: Metadata = { title: "Sign in with a code" };

// Off means absent: the page does not exist while the flag is off. The
// post-login target is the sealed redirect cookie set at /login, which the
// verify action consumes, so nothing about it travels through this page.
export default function EmailCodePage() {
  if (!toAuthSettings(env).emailOtp.enabled) notFound();
  return <CodeForm />;
}
