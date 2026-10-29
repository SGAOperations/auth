import type { ActionFailure, FailureCode } from "@/lib/admin/action-result";
import type { AuthzDecision, AuthzDenialReason } from "@/lib/authz";

// Pure and client-safe. Both records are exhaustive, so a new authz reason or
// failure code fails the typecheck until it has copy.

export const REASON_COPY: Record<AuthzDenialReason, string> = {
  ACTOR_INACTIVE: "Your account isn't active.",
  NOT_ADMIN: "Only admins can do this.",
  SELF_MODIFICATION: "You can't change your own admin access or status.",
  PRIMARY_ADMIN_PROTECTED:
    "The Primary Admin can only be changed through a Primary Admin transfer.",
  PRIMARY_ADMIN_REQUIRED:
    "Only the Primary Admin can do this to another admin.",
  TARGET_NOT_ELIGIBLE: "This user can't be chosen for this.",
  NOT_TRANSFER_RECIPIENT: "Only the transfer's recipient can do this.",
  NOT_TRANSFER_INITIATOR: "Only the transfer's sender can do this.",
};

export const FAILURE_COPY: Record<FailureCode, string> = {
  REAUTH_REQUIRED: "Confirm it's you to continue.",
  FORBIDDEN: "You don't have permission to do that.",
  NOT_FOUND: "That no longer exists. The page has been refreshed.",
  VALIDATION: "Check the details and try again.",
  POSITION_LIMIT: "Users can hold at most 50 positions.",
  POSITION_DELETED: "That position was deleted. Refresh and try again.",
  RATE_LIMITED: "Too many requests. Try again later.",
  CONFLICT: "That can't be done right now. Refresh and try again.",
  UNEXPECTED: "Something went wrong. Try again.",
};

/** The line a failure toast shows. */
export function failureMessage(failure: ActionFailure): string {
  if (failure.code === "FORBIDDEN" && failure.reason) {
    return REASON_COPY[failure.reason];
  }
  if (failure.code === "CONFLICT" && failure.message) return failure.message;
  return FAILURE_COPY[failure.code];
}

/** The line that explains a disabled control, or null when the action is allowed. */
export function disabledReason(decision: AuthzDecision): string | null {
  return decision.allowed ? null : REASON_COPY[decision.reason];
}

/** Narrows a server-sent code to an authorization reason. */
export function isDenialReason(code: unknown): code is AuthzDenialReason {
  return typeof code === "string" && Object.hasOwn(REASON_COPY, code);
}
