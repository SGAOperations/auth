import type { AuthzDenialReason } from "@/lib/authz";

// Pure and client-safe: the server actions return these and the client hook
// reads them.

export const FAILURE_CODES = [
  "REAUTH_REQUIRED",
  "FORBIDDEN",
  "NOT_FOUND",
  "VALIDATION",
  "POSITION_LIMIT",
  "POSITION_DELETED",
  "RATE_LIMITED",
  "CONFLICT",
  "UNEXPECTED",
] as const;

export type FailureCode = (typeof FAILURE_CODES)[number];

export type ActionResult =
  | {
      ok: true;
      /** What happened to an email the action sends, when it sends one. */
      email?: string;
    }
  | {
      ok: false;
      code: FailureCode;
      /** The authorization reason, set with `FORBIDDEN` when `can()` denied. */
      reason?: AuthzDenialReason;
      /** The server's own line, used for a `CONFLICT` that has no copy of its own. */
      message?: string;
    };

export type ActionFailure = Extract<ActionResult, { ok: false }>;
