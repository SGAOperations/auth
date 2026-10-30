import { createAuthClient } from "better-auth/react";
import {
  mapEmailStepResponse,
  mapSecondFactorError,
  type EmailStepOutcome,
  type SecondFactorMode,
  type SecondFactorState,
} from "@/lib/auth/forms";

// Client-safe: no env, no `server-only`. No `baseURL`, so the client uses the
// page's own origin, which differs per preview deployment.
export const authClient = createAuthClient();

export const EMAIL_STEP_PATH = "/api/sgauth/sign-in/email-step";

const SECOND_FACTOR_PATHS: Record<SecondFactorMode, string> = {
  totp: "/api/auth/two-factor/verify-totp",
  backup: "/api/auth/two-factor/verify-backup-code",
};

export type SecondFactorResult =
  | { ok: true }
  | { ok: false; state: SecondFactorState };

/**
 * The login page's second-factor step. Goes through the HTTP handler, so the
 * sign-in rate limit and the Origin check apply. Never throws: a network
 * failure is `unexpected`. It sends no `trustDevice`; the server forces it off.
 */
export async function postSecondFactor(
  mode: SecondFactorMode,
  code: string,
): Promise<SecondFactorResult> {
  try {
    const response = await fetch(SECOND_FACTOR_PATHS[mode], {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ code }),
      credentials: "same-origin",
      cache: "no-store",
    });
    if (response.ok) return { ok: true };
    const body: unknown = await response.json().catch(() => null);
    const errorCode =
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      typeof body.code === "string"
        ? body.code
        : undefined;
    return {
      ok: false,
      state: mapSecondFactorError({ status: response.status, code: errorCode }),
    };
  } catch {
    return { ok: false, state: "unexpected" };
  }
}

/**
 * The login page's email step. Never throws: a network failure is status 0,
 * which lets the page move on to the password step.
 */
export async function postEmailStep(email: string): Promise<EmailStepOutcome> {
  try {
    const response = await fetch(EMAIL_STEP_PATH, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email }),
      credentials: "same-origin",
      cache: "no-store",
    });
    const body: unknown = await response.json().catch(() => null);
    return mapEmailStepResponse({ status: response.status, body });
  } catch {
    return mapEmailStepResponse({ status: 0 });
  }
}
