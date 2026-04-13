import "server-only";
import type { AuthOtpResponse } from "@supabase/supabase-js";
import {
  AUTH_CALLBACK_PATH,
  DEFAULT_OTP_SHOULD_CREATE_USER,
} from "./auth-constants";
import { createServerSupabaseClient } from "./server";

export type SendOtpOptions = {
  /** Overrides default magic-link callback URL when set. */
  emailRedirectTo?: string;
  shouldCreateUser?: boolean;
  data?: Record<string, unknown>;
};

function getDefaultEmailRedirectTo(): string | undefined {
  const base = process.env.NEXT_PUBLIC_SITE_URL?.replace(/\/$/, "");
  if (!base) {
    return undefined;
  }
  return `${base}${AUTH_CALLBACK_PATH}`;
}

/**
 * Sends a one-time code / magic link via Supabase Auth (configured email provider).
 */
export async function sendOtp(
  email: string,
  options?: SendOtpOptions,
): Promise<AuthOtpResponse> {
  const supabase = await createServerSupabaseClient();
  return supabase.auth.signInWithOtp({
    email,
    options: {
      emailRedirectTo: options?.emailRedirectTo ?? getDefaultEmailRedirectTo(),
      shouldCreateUser:
        options?.shouldCreateUser ?? DEFAULT_OTP_SHOULD_CREATE_USER,
      data: options?.data,
    },
  });
}

/**
 * Verifies an email OTP and establishes a session (cookies via server client).
 */
export async function verifyOtp(email: string, token: string) {
  const supabase = await createServerSupabaseClient();
  return supabase.auth.verifyOtp({
    email,
    token,
    type: "email",
  });
}
