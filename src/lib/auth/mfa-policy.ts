import type { SgauthEnv } from "@/lib/env-schema";

// Pure and client-safe: no env, no I/O, no `server-only`. The login and
// enrollment screens import the error codes and the enrollment path from here.

/** Where an admin without MFA is sent to enroll. */
export const MFA_ENROLLMENT_PATH = "/account/security";

export const MFA_ERROR_CODES = {
  MFA_REQUIRED: {
    code: "MFA_REQUIRED",
    message:
      "Admins must turn on two-factor authentication before using admin tools.",
  },
  MFA_REQUIRED_FOR_ADMIN: {
    code: "MFA_REQUIRED_FOR_ADMIN",
    message:
      "Two-factor authentication can't be turned off while you are an admin.",
  },
} as const;

export interface MfaSubject {
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  twoFactorEnabled: boolean;
  status: string;
}

export type AdminMfaDecision =
  | { allowed: true }
  | { allowed: false; reason: "NOT_ACTIVE" | "NOT_ADMIN" | "MFA_REQUIRED" };

/**
 * Whether a user may use admin endpoints and pages. The Primary Admin is an
 * admin, so the same rule covers it.
 */
export function adminMfaDecision(user: MfaSubject): AdminMfaDecision {
  if (user.status !== "ACTIVE") return { allowed: false, reason: "NOT_ACTIVE" };
  if (!user.isAdmin) return { allowed: false, reason: "NOT_ADMIN" };
  if (!user.twoFactorEnabled) {
    return { allowed: false, reason: "MFA_REQUIRED" };
  }
  return { allowed: true };
}

/** Admins and the Primary Admin cannot turn MFA off. */
export function canDisableMfa(user: MfaSubject): boolean {
  return !user.isAdmin && !user.isPrimaryAdmin;
}

export type TransferRecipientDecision =
  | { allowed: true }
  | {
      allowed: false;
      reason:
        | "NOT_ACTIVE"
        | "NOT_ADMIN"
        | "MFA_REQUIRED"
        | "ALREADY_PRIMARY_ADMIN";
    };

/**
 * Whether a user may receive the Primary Admin role: an active, enrolled admin
 * who is not already the Primary Admin. Called when a transfer is initiated and
 * again when it is accepted.
 */
export function transferRecipientDecision(
  user: MfaSubject,
): TransferRecipientDecision {
  const decision = adminMfaDecision(user);
  if (!decision.allowed) return decision;
  if (user.isPrimaryAdmin) {
    return { allowed: false, reason: "ALREADY_PRIMARY_ADMIN" };
  }
  return { allowed: true };
}

/**
 * The issuer shown in an authenticator app, so dev and production entries can
 * be told apart.
 */
export function totpIssuer(sgauthEnv: SgauthEnv): string {
  return sgauthEnv === "production" ? "SGAuth" : `SGAuth (${sgauthEnv})`;
}
