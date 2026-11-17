"use server";

import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { z } from "zod";
import { getCurrentUser } from "@/lib/auth/current-user";
import { limitRequest } from "@/lib/rate-limit/server";
import {
  SLACK_STATE_COOKIE_MAX_AGE,
  slackReturnCookieName,
  stateCookieName,
  stateCookieSecure,
} from "@/lib/slack/oauth-state";
import {
  slackLoginResultPath,
  slackResultPath,
  type SlackResult,
} from "@/lib/slack/result";
import {
  confirmSlackLinkToken,
  startSlackConnect,
  unlinkOwnSlack,
} from "@/lib/slack/service";

// Next.js compares Origin with the host for server actions, and next.config.ts
// sets no `serverActions.allowedOrigins`, so only same-origin calls get here.
// The target is always the session user; no user id is read from the input.

async function signedInUser(
  path: string,
  resultPath: (result: SlackResult) => string = slackResultPath,
) {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent(path)}`);
  if (await limitRequest("slackLink", user.id)) {
    redirect(resultPath("rate_limited"));
  }
  return user;
}

/** The attributes of the Connect Slack state cookie, shared by the return cookie. */
const stateCookie = () =>
  ({
    httpOnly: true,
    secure: stateCookieSecure(),
    sameSite: "lax",
    path: "/",
    maxAge: SLACK_STATE_COOKIE_MAX_AGE,
  }) as const;

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
  const jar = await cookies();
  jar.set(stateCookieName("connect"), started.state, stateCookie());
  // A stale return cookie from an abandoned /login flow must not misroute.
  jar.set(slackReturnCookieName(), "", { ...stateCookie(), maxAge: 0 });
  redirect(started.url);
}

/**
 * Connect Slack, started from the /login interstitial for a leader the mandate
 * blocks (#361): the callback returns to /login, not the account page.
 */
export async function connectSlackToContinue(): Promise<void> {
  const user = await signedInUser("/login", slackLoginResultPath);
  const started = await startSlackConnect(user.id);
  if (!started) redirect(slackLoginResultPath("not_configured"));
  const jar = await cookies();
  jar.set(stateCookieName("connect"), started.state, stateCookie());
  jar.set(slackReturnCookieName(), "login", stateCookie());
  redirect(started.url);
}

/** Unlink on the account page. */
export async function unlinkSlack(): Promise<void> {
  const user = await signedInUser("/account");
  const removed = await unlinkOwnSlack(user.id);
  redirect(slackResultPath(removed ? "unlinked" : "unchanged"));
}
