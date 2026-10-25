import type { AuditEventType } from "@/lib/audit";

// Pure data, read by audit-coverage.test.ts. Every mutating route and every
// Better Auth endpoint is classified here, so a new one cannot ship without a
// decision about its audit event.

export type AuditCoverage =
  | { kind: "audited"; events: readonly AuditEventType[] }
  // A machine route whose audit events are written by `module`, not the route.
  | {
      kind: "job";
      module: string;
      events: readonly AuditEventType[];
    }
  | { kind: "exempt"; reason: string }
  | { kind: "read" }
  | { kind: "delegated"; to: "better-auth" };

/** Mutating App Router files (route handlers and server actions), by repo-relative path. */
export const APP_ROUTE_AUDIT: Record<string, AuditCoverage> = {
  "src/app/api/auth/[...all]/route.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  // The delete runs through Better Auth's /revoke-session, whose SESSION_REVOKED
  // is emitted by audit-hooks.ts.
  "src/app/api/sgauth/sessions/[id]/route.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  "src/app/api/sgauth/sessions/revoke-all/route.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  "src/app/preview-gate/unlock/route.ts": {
    kind: "exempt",
    reason:
      "preview-environment password gate; 404 outside preview; no identity or account state",
  },
  "src/app/api/csp-report/route.ts": {
    kind: "exempt",
    reason:
      "browser CSP violation reports; writes only an advisory log line, no account or session state",
  },
  "src/app/api/jobs/pa-transfer/route.ts": {
    kind: "job",
    module: "src/lib/jobs/pa-transfer.ts",
    events: [
      "PA_TRANSFER_COMPLETED",
      "PA_TRANSFER_EXPIRED",
      "PA_TRANSFER_CANCELLED",
    ],
  },
  "src/app/api/jobs/alerts/route.ts": {
    kind: "exempt",
    reason: "stub until #89/#90; no state change",
  },
  "src/app/api/jobs/retention/route.ts": {
    kind: "exempt",
    reason: "stub until #89/#90; no state change",
  },
};

const NO_SOCIAL = "no social providers are configured";
const NO_DELETE =
  "user.deleteUser is not enabled; users are never hard-deleted (ENGINEERING §2)";

/** Every Better Auth endpoint of the live plugin list, by path. */
export const AUTH_ENDPOINT_AUDIT: Record<string, AuditCoverage> = {
  "/sign-in/email": {
    kind: "audited",
    events: ["LOGIN_SUCCESS", "LOGIN_FAILED", "PASSWORD_REHASHED"],
  },
  "/sign-up/email": { kind: "audited", events: ["USER_CREATED"] },
  "/sign-out": { kind: "audited", events: ["LOGOUT"] },
  "/verify-email": {
    kind: "audited",
    events: ["EMAIL_VERIFIED", "LOGIN_SUCCESS"],
  },
  "/request-password-reset": {
    kind: "audited",
    events: ["PASSWORD_RESET_REQUESTED"],
  },
  "/reset-password": { kind: "audited", events: ["PASSWORD_RESET"] },
  "/change-password": { kind: "audited", events: ["PASSWORD_CHANGED"] },
  "/revoke-session": { kind: "audited", events: ["SESSION_REVOKED"] },
  "/revoke-sessions": { kind: "audited", events: ["SESSIONS_REVOKED"] },
  "/revoke-other-sessions": { kind: "audited", events: ["SESSIONS_REVOKED"] },

  "/get-session": {
    kind: "exempt",
    reason:
      "reads the session; its POST form only refreshes the session expiry, which is not a security event",
  },
  "/list-sessions": { kind: "read" },
  "/list-accounts": { kind: "read" },
  "/ok": { kind: "read" },
  "/error": { kind: "read" },
  "/reset-password/:token": { kind: "read" },

  "/sign-in/social": { kind: "exempt", reason: NO_SOCIAL },
  "/callback/:id": { kind: "exempt", reason: NO_SOCIAL },
  "/link-social": { kind: "exempt", reason: NO_SOCIAL },
  "/unlink-account": { kind: "exempt", reason: NO_SOCIAL },
  "/refresh-token": { kind: "exempt", reason: NO_SOCIAL },
  "/get-access-token": { kind: "exempt", reason: NO_SOCIAL },
  "/account-info": { kind: "exempt", reason: NO_SOCIAL },
  "/delete-user": { kind: "exempt", reason: NO_DELETE },
  "/delete-user/callback": { kind: "exempt", reason: NO_DELETE },
  "/change-email": {
    kind: "exempt",
    reason: "user.changeEmail is not enabled",
  },
  "/update-user": {
    kind: "exempt",
    reason:
      "self-service name and image only; status and email are not writable here, and the catalog has no profile-edit event",
  },
  "/update-session": { kind: "exempt", reason: "no writable session fields" },
  "/send-verification-email": {
    kind: "exempt",
    reason: "sends mail only; no account state changes",
  },
  "/verify-password": { kind: "exempt", reason: "read-only password check" },
  "/jwks": {
    kind: "exempt",
    reason:
      "public key set; mints the first key pair lazily when none exists, no account or session state",
  },
  "/token": {
    kind: "exempt",
    reason:
      "mints a 10-minute JWT from an existing session; no state change; refreshed about every 9 minutes, so auditing it would flood the append-only table",
  },
};
