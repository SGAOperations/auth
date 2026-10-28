import "server-only";
import { apiError } from "@/lib/admin-api";
import type { AuthzDenialReason } from "@/lib/authz";

/** The codes this module answers itself; the shared guard owns the rest. */
export const ADMIN_USER_ERROR_MESSAGES = {
  USER_NOT_FOUND: "That user doesn't exist.",
  UNKNOWN_ACTION: "Unknown action.",
  EMAIL_TAKEN: "An account with that email already exists.",
  USER_DELETED: "This account has been deleted.",
  ALREADY_DEACTIVATED: "This account is already deactivated.",
  NOT_DEACTIVATED: "This account isn't deactivated.",
  ALREADY_ADMIN: "This user is already an admin.",
  NOT_AN_ADMIN: "This user isn't an admin.",
  NOT_LOCKED: "This account isn't locked.",
  MFA_NOT_ENROLLED: "This user hasn't set up two-factor authentication.",
  PASSWORD_ALREADY_SET: "This user has already set a password.",
  USER_DEACTIVATED: "Reactivate this account before sending an invite.",
  INVITE_LIMIT: "This user has had 3 invites today. Try again tomorrow.",
  INTERNAL_ERROR: "Something went wrong. Try again.",
} as const;

export type AdminUserErrorCode = keyof typeof ADMIN_USER_ERROR_MESSAGES;

/** Each code's status, so a precondition names only the code. */
export const ADMIN_USER_ERROR_STATUS: Record<AdminUserErrorCode, number> = {
  USER_NOT_FOUND: 404,
  UNKNOWN_ACTION: 404,
  EMAIL_TAKEN: 409,
  USER_DELETED: 409,
  ALREADY_DEACTIVATED: 409,
  NOT_DEACTIVATED: 409,
  ALREADY_ADMIN: 409,
  NOT_AN_ADMIN: 409,
  NOT_LOCKED: 409,
  MFA_NOT_ENROLLED: 409,
  PASSWORD_ALREADY_SET: 409,
  USER_DEACTIVATED: 409,
  INVITE_LIMIT: 429,
  INTERNAL_ERROR: 500,
};

export function userError(
  code: AdminUserErrorCode,
  extra?: Record<string, unknown>,
): Response {
  return apiError(
    ADMIN_USER_ERROR_STATUS[code],
    code,
    ADMIN_USER_ERROR_MESSAGES[code],
    extra,
  );
}

// The reasons with their own copy; any other reason gets the generic line.
const DENIAL_MESSAGES: Partial<Record<AuthzDenialReason, string>> = {
  SELF_MODIFICATION: "You can't do this to your own account.",
  PRIMARY_ADMIN_PROTECTED:
    "The Primary Admin's account can only be changed through a Primary Admin transfer.",
  PRIMARY_ADMIN_REQUIRED:
    "Only the Primary Admin can do this to another admin.",
};

const DEFAULT_DENIAL_MESSAGE = "You can't do that to this user.";

/** 403 with the authz reason as `code`. */
export function denied(reason: AuthzDenialReason): Response {
  return apiError(
    403,
    reason,
    DENIAL_MESSAGES[reason] ?? DEFAULT_DENIAL_MESSAGE,
  );
}
