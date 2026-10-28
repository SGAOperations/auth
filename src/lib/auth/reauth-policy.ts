import { z } from "zod";
import { PASSWORD_MAX_LENGTH } from "@/lib/auth/policy";

// Client-safe on purpose: no env, no DB. The re-auth dialog imports the body
// schema and the error codes, so client and server share one contract. The
// rule is documented in docs/REAUTH.md.

/**
 * How long a re-authentication stays good. Independent of Better Auth's
 * `freshAge`, which is left at its default.
 */
export const REAUTH_WINDOW_MS = 10 * 60 * 1000;

/**
 * True only when the stamp is set and no more than the window old. A stamp in
 * the future is never fresh, so a clock fault cannot extend the window.
 */
export function isFresh(lastReauthAt: Date | null, now: Date): boolean {
  if (!lastReauthAt) return false;
  const age = now.getTime() - lastReauthAt.getTime();
  return age >= 0 && age <= REAUTH_WINDOW_MS;
}

export const REAUTH_ERROR_CODES = {
  REAUTH_REQUIRED: {
    code: "REAUTH_REQUIRED",
    message: "Confirm it's you to continue.",
  },
  INVALID_REAUTH_CREDENTIALS: {
    code: "INVALID_REAUTH_CREDENTIALS",
    message: "That password or code is incorrect.",
  },
  TWO_FACTOR_CODE_REQUIRED: {
    code: "TWO_FACTOR_CODE_REQUIRED",
    message: "Enter the code from your authenticator app.",
  },
  REAUTH_LOCKED: {
    code: "REAUTH_LOCKED",
    message:
      "Too many failed attempts. Try again later, or use the unlock link we emailed you.",
  },
} as const;

export const reauthBodySchema = z.strictObject({
  password: z.string().min(1, "Enter your password.").max(PASSWORD_MAX_LENGTH),
  // A TOTP code or a backup code.
  code: z.string().trim().min(1).max(32).optional(),
});

export type ReauthBody = z.infer<typeof reauthBodySchema>;

/** A six-digit code is a TOTP; anything else is tried as a backup code. */
export function classifySecondFactor(code: string): "totp" | "backup_code" {
  return /^\d{6}$/.test(code) ? "totp" : "backup_code";
}

/**
 * The Better Auth endpoints that answer 403 `REAUTH_REQUIRED` until the session
 * has re-authenticated. Add a path here for a sensitive endpoint Better Auth
 * already serves; an SGAuth route handler calls `requireFreshAuth()` instead.
 */
export const FRESH_AUTH_AUTH_PATHS: readonly string[] = [
  // Changing the password.
  "/change-password",
  // Revoking every session, this one included.
  "/revoke-sessions",
  // Revoking every session but this one.
  "/revoke-other-sessions",
  // Starting MFA enrollment.
  "/two-factor/enable",
  // Turning MFA off.
  "/two-factor/disable",
  // Reveals the TOTP secret.
  "/two-factor/get-totp-uri",
  // Replaces the backup codes.
  "/two-factor/generate-backup-codes",
];
