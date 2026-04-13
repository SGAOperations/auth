/**
 * Defaults for org-wide OTP / magic-link behavior. Override per call via sendOtp options when needed.
 */
export const AUTH_CALLBACK_PATH = "/auth/callback";

/** Supabase default is true; we set explicitly so behavior stays obvious in code review. */
export const DEFAULT_OTP_SHOULD_CREATE_USER = true;
