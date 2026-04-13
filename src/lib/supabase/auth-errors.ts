import type { AuthError } from "@supabase/supabase-js";

/**
 * Maps Supabase Auth errors to stable query-param codes for the UI layer.
 * Never expose raw provider messages in redirects.
 */
export function authErrorToQueryCode(error: AuthError): string {
  const status = error.status;
  const msg = error.message.toLowerCase();

  if (status === 400 || msg.includes("expired") || msg.includes("invalid")) {
    return "session_invalid";
  }
  if (msg.includes("rate limit") || status === 429) {
    return "rate_limited";
  }
  return "auth_failed";
}
