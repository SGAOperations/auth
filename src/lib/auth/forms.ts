import { z } from "zod";
import {
  AUTH_ERROR_CODES,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
  isAllowedSignupEmail,
  passwordSchema,
} from "@/lib/auth/policy";

// Client-safe: zod and policy constants only. Page copy and error mapping live
// here so the enumeration rules are tested in one place.

export const AUTH_COPY = {
  wordmark: "Northeastern SGA",
  brandLine: "One SGA account signs you in to every SGA tool.",
  noScript: "Turn on JavaScript to use this page.",
  unexpected: "Something went wrong. Try again in a moment.",
  invalidEmail: "Enter a valid email address.",

  emailStepRateLimited:
    "Too many sign-in attempts. Wait a few minutes and try again.",
  firstSignInHint:
    "First time signing in? If your account doesn't have a password yet, we've emailed you a link to set one.",
  signInInvalid: "Incorrect email or password.",
  signInUnverified:
    "Verify your email before signing in. Check your inbox for the link we sent when you signed up.",
  signInDeactivated: AUTH_ERROR_CODES.ACCOUNT_DEACTIVATED.message,
  signInRateLimited: "Too many sign-in attempts. Wait a minute and try again.",
  signInTwoFactor:
    "This account uses two-factor sign-in, which this page can't complete yet.",

  signUpRateLimited:
    "Too many sign-up attempts from this network. Try again later.",
  passwordTooShort: `Use at least ${PASSWORD_MIN_LENGTH} characters.`,
  passwordTooLong: `Use ${PASSWORD_MAX_LENGTH} characters or fewer.`,

  forgotRateLimited: "Too many reset requests. Try again in 10 minutes.",

  resendSent: "If this address still needs verifying, we've sent a new link.",
  resendRateLimited:
    "You've asked for several links in the last hour. Try again later.",

  lengthShort: `At least ${PASSWORD_MIN_LENGTH} characters`,
  lengthOk: "Length looks good",
  lengthLong: `${PASSWORD_MAX_LENGTH} characters at most`,
} as const;

// ---- Schemas ---------------------------------------------------------------

const emailField = z.string().trim().pipe(z.email().max(320));

export const emailStepSchema = z.object({ email: emailField });

export const signInSchema = z.object({
  // No minimum: an older or imported password must still reach the server.
  password: z.string().min(1).max(PASSWORD_MAX_LENGTH),
});

export const signUpSchema = z.object({
  name: z.string().trim().min(1).max(100),
  email: emailField.refine(isAllowedSignupEmail, {
    message: AUTH_ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED.message,
  }),
  password: passwordSchema,
});

export const forgotPasswordSchema = z.object({ email: emailField });

export type EmailStepValues = z.infer<typeof emailStepSchema>;
export type SignInValues = z.infer<typeof signInSchema>;
export type SignUpValues = z.infer<typeof signUpSchema>;
export type ForgotPasswordValues = z.infer<typeof forgotPasswordSchema>;

export type PasswordLengthState = "short" | "ok" | "long";

export function passwordLengthState(length: number): PasswordLengthState {
  if (length < PASSWORD_MIN_LENGTH) return "short";
  if (length > PASSWORD_MAX_LENGTH) return "long";
  return "ok";
}

export function passwordLengthMessage(state: PasswordLengthState): string {
  switch (state) {
    case "short":
      return AUTH_COPY.lengthShort;
    case "ok":
      return AUTH_COPY.lengthOk;
    case "long":
      return AUTH_COPY.lengthLong;
  }
}

// ---- Error mapping ---------------------------------------------------------

/** The shape Better Auth's client returns for a failed call. */
export interface AuthClientError {
  status: number;
  code?: string;
  message?: string;
}

export type EmailStepOutcome =
  | { kind: "password"; hint: boolean }
  | { kind: "field-error"; message: string }
  | { kind: "rate-limited" };

// Only a 200 shows the hint; any other status still reaches the password step.
export function mapEmailStepResponse({
  status,
  body,
}: {
  status: number;
  body?: unknown;
}): EmailStepOutcome {
  if (status === 200) return { kind: "password", hint: true };
  if (status === 400) {
    const message =
      typeof body === "object" &&
      body !== null &&
      "message" in body &&
      typeof body.message === "string" &&
      body.message !== ""
        ? body.message
        : AUTH_COPY.invalidEmail;
    return { kind: "field-error", message };
  }
  if (status === 429) return { kind: "rate-limited" };
  return { kind: "password", hint: false };
}

export type SignInState =
  | "invalid"
  | "unverified"
  | "deactivated"
  | "rate-limited"
  | "two-factor"
  | "unexpected";

export function mapSignInError(error: AuthClientError): SignInState {
  if (error.code === "INVALID_EMAIL_OR_PASSWORD") return "invalid";
  if (error.code === "EMAIL_NOT_VERIFIED") return "unverified";
  if (error.code === AUTH_ERROR_CODES.ACCOUNT_DEACTIVATED.code) {
    return "deactivated";
  }
  if (error.status === 429) return "rate-limited";
  // Unknown email, wrong password, password-less and locked accounts all come
  // back as the same 401: never tell them apart.
  if (error.status === 401) return "invalid";
  return "unexpected";
}

export function signInMessage(state: SignInState): string {
  switch (state) {
    case "invalid":
      return AUTH_COPY.signInInvalid;
    case "unverified":
      return AUTH_COPY.signInUnverified;
    case "deactivated":
      return AUTH_COPY.signInDeactivated;
    case "rate-limited":
      return AUTH_COPY.signInRateLimited;
    case "two-factor":
      return AUTH_COPY.signInTwoFactor;
    case "unexpected":
      return AUTH_COPY.unexpected;
  }
}

export interface SignUpErrorResult {
  /** The field to attach the message to, or null for the form as a whole. */
  field: "email" | "password" | null;
  message: string;
}

export function mapSignUpError(error: AuthClientError): SignUpErrorResult {
  switch (error.code) {
    case "EMAIL_DOMAIN_NOT_ALLOWED":
      return {
        field: "email",
        message: AUTH_ERROR_CODES.EMAIL_DOMAIN_NOT_ALLOWED.message,
      };
    case "PASSWORD_TOO_SHORT":
      return { field: "password", message: AUTH_COPY.passwordTooShort };
    case "PASSWORD_TOO_LONG":
      return { field: "password", message: AUTH_COPY.passwordTooLong };
  }
  if (error.status === 403 && error.message) {
    // The preview environment's invite-only message.
    return { field: null, message: error.message };
  }
  if (error.status === 429) {
    return { field: null, message: AUTH_COPY.signUpRateLimited };
  }
  return { field: null, message: AUTH_COPY.unexpected };
}

export type RequestErrorState = "rate-limited" | "unexpected";

/** For forgot-password and the verification resend. */
export function mapRequestError(error: AuthClientError): RequestErrorState {
  return error.status === 429 ? "rate-limited" : "unexpected";
}
