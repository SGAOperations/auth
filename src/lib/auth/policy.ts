import { z } from "zod";

// Client-safe on purpose: no env, no DB. The sign-up and sign-in forms
// (AUTH-T25) import passwordSchema, so client and server share one rule.

export const SIGNUP_EMAIL_DOMAIN = "northeastern.edu";
export const PASSWORD_MIN_LENGTH = 12;
export const PASSWORD_MAX_LENGTH = 128;
export const VERIFICATION_TOKEN_TTL_SECONDS = 86_400;

export const AUTH_ERROR_CODES = {
  EMAIL_DOMAIN_NOT_ALLOWED: {
    code: "EMAIL_DOMAIN_NOT_ALLOWED",
    message: "Sign-up requires a northeastern.edu email address.",
  },
  ACCOUNT_DEACTIVATED: {
    code: "ACCOUNT_DEACTIVATED",
    message:
      "This account has been deactivated. Contact SGA if you think this is a mistake.",
  },
  PASSWORD_CHANGE_LOCKED: {
    code: "PASSWORD_CHANGE_LOCKED",
    message:
      "Too many failed attempts. Try again later, or use the unlock link we emailed you.",
  },
  NEW_PASSWORD_SAME_AS_CURRENT: {
    code: "NEW_PASSWORD_SAME_AS_CURRENT",
    message: "Choose a password you aren't already using.",
  },
} as const;

export const passwordSchema = z
  .string()
  .min(PASSWORD_MIN_LENGTH)
  .max(PASSWORD_MAX_LENGTH);

/** The change-password form (AUTH-T54); the server rule is the same. */
export const changePasswordFormSchema = z
  .object({
    currentPassword: z.string().min(1).max(PASSWORD_MAX_LENGTH),
    newPassword: passwordSchema,
    confirmPassword: z.string(),
  })
  .refine((value) => value.confirmPassword === value.newPassword, {
    path: ["confirmPassword"],
  })
  .refine((value) => value.newPassword !== value.currentPassword, {
    path: ["newPassword"],
  });

export function normalizeEmail(raw: string): string {
  return raw.trim().toLowerCase();
}

/** Exact domain match on the part after the last `@`. */
export function isAllowedSignupEmail(raw: string): boolean {
  const email = normalizeEmail(raw);
  const at = email.lastIndexOf("@");
  if (at < 1) return false;
  const local = email.slice(0, at);
  if (local.includes("@")) return false;
  return email.slice(at + 1) === SIGNUP_EMAIL_DOMAIN;
}
