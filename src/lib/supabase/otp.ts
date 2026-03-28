import "server-only";
import type { AuthOtpResponse } from "@supabase/supabase-js";
import { createServerSupabaseClient } from "./server";

export type SendOtpOptions = {
  /** Where email links should redirect (magic link / PKCE). Must be in Supabase redirect allow list. */
  emailRedirectTo?: string;
  shouldCreateUser?: boolean;
  data?: Record<string, unknown>;
};

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
      emailRedirectTo: options?.emailRedirectTo,
      shouldCreateUser: options?.shouldCreateUser,
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
