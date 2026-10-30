import { passkeyClient } from "@better-auth/passkey/client";
import { createAuthClient } from "better-auth/react";
import { mapEmailStepResponse, type EmailStepOutcome } from "@/lib/auth/forms";

// Client-safe: no env, no `server-only`. No `baseURL`, so the client uses the
// page's own origin, which differs per preview deployment.
export const authClient = createAuthClient({ plugins: [passkeyClient()] });

export const EMAIL_STEP_PATH = "/api/sgauth/sign-in/email-step";

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
