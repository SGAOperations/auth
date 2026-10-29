// Pure on purpose: no `server-only` and no I/O, so every rule is tested without
// a database. The server module (email-otp.ts) loads the rows and applies it.

/** Why an address cannot sign in by emailed code. */
export type OtpRefusal =
  | "no_account"
  | "inactive"
  | "unverified"
  | "admin"
  | "mfa"
  | "locked";

export interface OtpUser {
  status: string;
  emailVerified: boolean;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  twoFactorEnabled: boolean | null;
}

/**
 * Whether `user` may sign in by emailed code. A code proves control of the
 * mailbox and nothing more, so it never replaces a second factor: Better Auth's
 * twoFactor plugin intercepts only the password, username and phone sign-ins,
 * and an OTP sign-in would skip TOTP. Admins and accounts with MFA are refused
 * for that reason.
 *
 * `locked` is the outcome of the password lockout for this browser: a valid
 * known-device cookie for the account is exempt from the account lock, exactly
 * as it is at the password step, so the caller passes `false` for it.
 *
 * The first refusal that applies wins, in the order of the type above.
 */
export function otpEligibility(
  user: OtpUser | null,
  locked: boolean,
): "ok" | OtpRefusal {
  if (user === null) return "no_account";
  if (user.status !== "ACTIVE") return "inactive";
  if (!user.emailVerified) return "unverified";
  if (user.isAdmin || user.isPrimaryAdmin) return "admin";
  if (user.twoFactorEnabled) return "mfa";
  if (locked) return "locked";
  return "ok";
}

/**
 * Whether the global daily counter, read after this send's increment, is over
 * its cap. The `cap`th send is the last one allowed.
 */
export function dailyCapReached(count: number, cap: number): boolean {
  return count > cap;
}
