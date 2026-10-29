"use server";

import { isAPIError } from "better-auth/api";
import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { z } from "zod";
import { auth } from "@/lib/auth/server";
import {
  emailCodeRequestSchema,
  emailCodeVerifySchema,
  mapEmailCodeError,
  type EmailCodeErrorState,
} from "@/lib/auth/forms";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { consumeRedirect } from "@/lib/redirect/consume";

// Sign-in by emailed code. Both actions are anonymous by nature: control of the
// mailbox is the credential, and eligibility (active, verified, not an admin,
// no MFA, not locked) is enforced by the plugin at send and at sign-in, with
// the rate limits and the daily cap. Server actions get Next.js's Origin-vs-Host
// check; none sets `allowedOrigins`.

export type EmailCodeFailure = {
  ok: false;
  state: EmailCodeErrorState;
  /** Set with `rate-limited`. */
  retryAfterMinutes?: number;
};

export type RequestCodeResult = { ok: true } | EmailCodeFailure;

const retryAfterBody = z.looseObject({ retryAfterSeconds: z.number() });

function failure(error: unknown): EmailCodeFailure {
  if (!isAPIError(error)) return { ok: false, state: "unexpected" };
  const body = z.looseObject({ code: z.string() }).safeParse(error.body);
  const state = mapEmailCodeError({
    status: error.statusCode,
    code: body.success ? body.data.code : undefined,
  });
  if (state !== "rate-limited") return { ok: false, state };
  const retry = retryAfterBody.safeParse(error.body);
  return {
    ok: false,
    state,
    retryAfterMinutes: retry.success
      ? Math.max(1, Math.ceil(retry.data.retryAfterSeconds / 60))
      : 1,
  };
}

// With the flag off the plugin is not registered, so there is nothing to call.
function assertEnabled() {
  if (!toAuthSettings(env).emailOtp.enabled) notFound();
}

/**
 * Step 1. Every accepted request answers the same, whether or not the address
 * has an account that may use a code: the check happens in the deferred send.
 */
export async function requestCode(input: unknown): Promise<RequestCodeResult> {
  assertEnabled();
  const parsed = emailCodeRequestSchema.safeParse(input);
  if (!parsed.success) return { ok: false, state: "invalid" };
  try {
    await auth.api.sendVerificationOTP({
      body: { email: parsed.data.email, type: "sign-in" },
      headers: await headers(),
    });
    return { ok: true };
  } catch (error) {
    return failure(error);
  }
}

/**
 * Step 2. On success the session cookie is set (by `nextCookies`) and the
 * browser is redirected to the validated target, or `/account`.
 */
export async function verifyCode(input: unknown): Promise<EmailCodeFailure> {
  assertEnabled();
  const parsed = emailCodeVerifySchema.safeParse(input);
  if (!parsed.success) return { ok: false, state: "invalid" };
  try {
    await auth.api.signInEmailOTP({
      body: { email: parsed.data.email, otp: parsed.data.otp },
      headers: await headers(),
    });
  } catch (error) {
    return failure(error);
  }
  redirect(await consumeRedirect());
}
