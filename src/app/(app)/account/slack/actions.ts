"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { limitRequest } from "@/lib/rate-limit/server";
import {
  SLACK_STATE_COOKIE_MAX_AGE,
  confirmSlackLinkToken,
  slackStateCookieName,
  slackStateCookieSecure,
  startSlackConnect,
  unlinkOwnSlack,
} from "@/lib/slack/service";
import { slackResultPath } from "@/lib/slack/result";

// Next.js compares Origin with the host for server actions, and next.config.ts
// sets no `serverActions.allowedOrigins`, so only same-origin calls get here.
// The target is always the session user; no user id is read from the input.

async function signedInUser(path: string) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent(path)}`);
  if (await limitRequest("slackLink", user.id)) {
    redirect(slackResultPath("rate_limited"));
  }
  return user;
}

const tokenSchema = z.string().min(1).max(128);

/** The Confirm button on the page a product's DM'd link opens. */
export async function confirmSlackLink(formData: FormData): Promise<void> {
  const token = tokenSchema.safeParse(formData.get("token"));
  const user = await signedInUser("/account");
  const outcome = token.success
    ? await confirmSlackLinkToken(user.id, token.data)
    : "invalid_token";
  redirect(slackResultPath(outcome));
}

/** Connect Slack: off to Slack's sign-in, bound to this browser by a cookie. */
export async function connectSlack(): Promise<void> {
  const user = await signedInUser("/account");
  const started = await startSlackConnect(user.id);
  if (!started) redirect(slackResultPath("not_configured"));
  (await cookies()).set(slackStateCookieName(), started.state, {
    httpOnly: true,
    secure: slackStateCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: SLACK_STATE_COOKIE_MAX_AGE,
  });
  redirect(started.url);
}

/** Unlink on the account page. */
export async function unlinkSlack(): Promise<void> {
  const user = await signedInUser("/account");
  const removed = await unlinkOwnSlack(user.id);
  redirect(slackResultPath(removed ? "unlinked" : "unchanged"));
}
