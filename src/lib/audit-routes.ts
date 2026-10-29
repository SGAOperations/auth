import type { AuditEventType } from "@/lib/audit";

// Pure data, read by audit-coverage.test.ts. Every mutating route and every
// Better Auth endpoint is classified here, so a new one cannot ship without a
// decision about its audit event.

export type AuditCoverage =
  // `emittedIn` lists the modules that write the events when the route file
  // does not; the check reads them together with the route.
  | {
      kind: "audited";
      events: readonly AuditEventType[];
      emittedIn?: readonly string[];
    }
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
  // REAUTH_SUCCEEDED and REAUTH_FAILED come from the sgauth-reauth plugin
  // endpoint that the POST reaches through auth.api.sgauthReauthenticate.
  "src/app/api/sgauth/reauth/route.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  // EMAIL_VERIFIED and LOGIN_SUCCESS come from the Better Auth hooks that the
  // POST reaches through auth.api.verifyEmail.
  "src/app/verify-email/confirm/route.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  "src/app/verify-email/resend/route.ts": {
    kind: "exempt",
    reason: "sends mail only; no account state changes",
  },
  // PASSWORD_RESET (and ACCOUNT_UNLOCKED when a lock was live) come from the
  // Better Auth hooks that the POST reaches through auth.api.resetPassword.
  "src/app/reset-password/confirm/route.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  // The unlock link's POST writes ACCOUNT_UNLOCKED in its own transaction.
  "src/app/unlock/confirm/route.ts": {
    kind: "audited",
    events: ["ACCOUNT_UNLOCKED"],
  },
  // The Primary Admin transfer routes. Every transition writes its
  // own audit row inside pa-transfer-actions.ts, in the transition's transaction.
  "src/app/api/sgauth/admin/transfer/route.ts": {
    kind: "audited",
    events: ["PA_TRANSFER_INITIATED"],
    emittedIn: ["src/lib/jobs/pa-transfer-actions.ts"],
  },
  "src/app/api/sgauth/admin/transfer/[id]/accept/route.ts": {
    kind: "audited",
    events: ["PA_TRANSFER_ACCEPTED"],
    emittedIn: ["src/lib/jobs/pa-transfer-actions.ts"],
  },
  "src/app/api/sgauth/admin/transfer/[id]/decline/route.ts": {
    kind: "audited",
    events: ["PA_TRANSFER_CANCELLED"],
    emittedIn: ["src/lib/jobs/pa-transfer-actions.ts"],
  },
  "src/app/api/sgauth/admin/transfer/[id]/cancel/route.ts": {
    kind: "audited",
    events: ["PA_TRANSFER_CANCELLED"],
    emittedIn: ["src/lib/jobs/pa-transfer-actions.ts"],
  },
  // The emailed cancel link's POST. consumeCancelToken writes the event in the
  // consuming transaction.
  "src/app/transfer/cancel/confirm/route.ts": {
    kind: "audited",
    events: ["PA_TRANSFER_CANCELLED"],
    emittedIn: ["src/lib/jobs/pa-transfer-actions.ts"],
  },
  "src/app/api/sgauth/admin/positions/route.ts": {
    kind: "audited",
    events: ["POSITION_CREATED"],
  },
  "src/app/api/sgauth/admin/positions/[id]/route.ts": {
    kind: "audited",
    events: ["POSITION_UPDATED", "POSITION_DELETED"],
  },
  "src/app/api/sgauth/admin/users/[id]/positions/route.ts": {
    kind: "audited",
    events: ["POSITION_ASSIGNED", "POSITION_UNASSIGNED"],
  },
  "src/app/api/sgauth/admin/positions/[id]/holders/route.ts": {
    kind: "audited",
    events: ["POSITION_ASSIGNED"],
  },
  // Admin user management (AUTH-T36). The route files only bind the handlers;
  // each mutation writes its single audit row inside its own transaction.
  "src/app/api/sgauth/admin/users/route.ts": {
    kind: "audited",
    events: ["USER_CREATED"],
    emittedIn: ["src/lib/admin/users/handlers.ts"],
  },
  // Bulk CSV import (AUTH-T41). The apply route writes one BULK_IMPORT, one
  // USER_CREATED per new account and one POSITION_ASSIGNED per inserted pair in
  // its transaction; USER_INVITED comes from the post-commit invite sender.
  "src/app/api/sgauth/admin/users/import/route.ts": {
    kind: "audited",
    events: [
      "BULK_IMPORT",
      "USER_CREATED",
      "POSITION_ASSIGNED",
      "USER_INVITED",
    ],
    emittedIn: [
      "src/lib/user-import/handlers.ts",
      "src/lib/user-import/invite-sender.ts",
    ],
  },
  "src/app/api/sgauth/admin/users/import/preview/route.ts": {
    kind: "exempt",
    reason: "dry run: validates and diffs the CSV, writes nothing",
  },
  "src/app/api/sgauth/admin/users/[id]/route.ts": {
    kind: "audited",
    events: ["USER_UPDATED", "USER_DELETED"],
    emittedIn: [
      "src/lib/admin/users/handlers.ts",
      "src/lib/users/tombstone.ts",
    ],
  },
  "src/app/api/sgauth/admin/users/[id]/[action]/route.ts": {
    kind: "audited",
    events: [
      "USER_DEACTIVATED",
      "USER_REACTIVATED",
      "ADMIN_GRANTED",
      "ADMIN_REVOKED",
      "SESSIONS_REVOKED",
      "ACCOUNT_UNLOCKED",
      "MFA_RESET",
      "USER_INVITED",
    ],
    emittedIn: ["src/lib/admin/users/actions.ts"],
  },
  // The set-password link (AUTH-T22). The two request routes write
  // PASSWORD_SET_REQUESTED in the service, only when a token is issued. The
  // confirm POST writes PASSWORD_SET in the consumer's transaction, then signs
  // in through Better Auth, whose hooks write LOGIN_SUCCESS.
  "src/app/api/sgauth/sign-in/email-step/route.ts": {
    kind: "audited",
    events: ["PASSWORD_SET_REQUESTED"],
    emittedIn: ["src/lib/set-password/service.ts"],
  },
  "src/app/set-password/request/route.ts": {
    kind: "audited",
    events: ["PASSWORD_SET_REQUESTED"],
    emittedIn: ["src/lib/set-password/service.ts"],
  },
  "src/app/set-password/confirm/route.ts": {
    kind: "audited",
    events: ["PASSWORD_SET"],
    emittedIn: ["src/lib/set-password/consumer.ts"],
  },
  // Admin product registry server actions. Each writes its audit row in the same
  // transaction as the product write.
  "src/app/(app)/admin/products/actions.ts": {
    kind: "audited",
    events: ["PRODUCT_CREATED", "PRODUCT_UPDATED", "PRODUCT_DELETED"],
  },
  // LOGIN_SUCCESS and LOGIN_FAILED come from the Better Auth hooks that the
  // action reaches through auth.api.signInEmailOTP.
  "src/app/login/code/actions.ts": {
    kind: "delegated",
    to: "better-auth",
  },
  "src/app/login/actions.ts": {
    kind: "exempt",
    reason:
      "reads the session and clears the post-login redirect cookie; no account or session state changes",
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
      "SESSIONS_REVOKED",
    ],
  },
  "src/app/api/jobs/alerts/route.ts": {
    kind: "exempt",
    reason: "stub until #89/#90; no state change",
  },
  // Every tombstone the job makes writes its one USER_DELETED row there. The
  // other steps (purge, IP/UA nulling, notices) are not audited events.
  "src/app/api/jobs/retention/route.ts": {
    kind: "job",
    module: "src/lib/users/tombstone.ts",
    events: ["USER_DELETED"],
  },
};

const NO_SOCIAL = "no social providers are configured";
const NO_DELETE =
  "user.deleteUser is not enabled; users are never hard-deleted (ENGINEERING §2)";

const NO_OTP =
  "email and SMS OTP is not configured (no otpOptions.sendOTP); always fails";

const NO_EMAIL_OTP_HTTP =
  "disabled over HTTP (EMAIL_OTP_DISABLED_PATHS); no in-process caller, because an emailed code only signs in";

/** Every Better Auth endpoint of the live plugin list, by path. */
export const AUTH_ENDPOINT_AUDIT: Record<string, AuditCoverage> = {
  "/sign-in/email": {
    kind: "audited",
    events: [
      "LOGIN_SUCCESS",
      "LOGIN_FAILED",
      "PASSWORD_REHASHED",
      "ACCOUNT_LOCKED",
    ],
  },
  "/sign-up/email": { kind: "audited", events: ["USER_CREATED"] },
  "/sign-out": { kind: "audited", events: ["LOGOUT"] },
  // HTTP-disabled (disabledPaths): reached only in-process, by the POST at
  // src/app/verify-email/confirm/route.ts.
  "/verify-email": {
    kind: "audited",
    events: ["EMAIL_VERIFIED", "LOGIN_SUCCESS"],
  },
  "/request-password-reset": {
    kind: "audited",
    events: ["PASSWORD_RESET_REQUESTED"],
  },
  "/reset-password": {
    kind: "audited",
    events: ["PASSWORD_RESET", "ACCOUNT_UNLOCKED"],
  },
  "/change-password": {
    kind: "audited",
    events: ["PASSWORD_CHANGED", "PASSWORD_CHANGE_FAILED", "ACCOUNT_LOCKED"],
  },
  "/revoke-session": { kind: "audited", events: ["SESSION_REVOKED"] },
  "/revoke-sessions": { kind: "audited", events: ["SESSIONS_REVOKED"] },
  "/revoke-other-sessions": { kind: "audited", events: ["SESSIONS_REVOKED"] },
  "/two-factor/verify-totp": {
    kind: "audited",
    events: ["LOGIN_SUCCESS", "LOGIN_FAILED", "MFA_ENROLLED"],
  },
  "/two-factor/verify-backup-code": {
    kind: "audited",
    events: ["LOGIN_SUCCESS", "LOGIN_FAILED", "MFA_BACKUP_USED"],
  },
  "/two-factor/disable": { kind: "audited", events: ["MFA_DISABLED"] },
  "/two-factor/generate-backup-codes": {
    kind: "audited",
    events: ["MFA_BACKUP_CODES_REGENERATED"],
  },
  "/two-factor/enable": {
    kind: "exempt",
    reason:
      "starts enrollment; nothing is enabled until /two-factor/verify-totp, which emits MFA_ENROLLED",
  },
  "/two-factor/get-totp-uri": {
    kind: "exempt",
    reason: "returns the enrollment URI; no state change",
  },
  "/two-factor/send-otp": { kind: "exempt", reason: NO_OTP },
  "/two-factor/verify-otp": { kind: "exempt", reason: NO_OTP },

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
      "self-service name and image only; status and email are not writable here; USER_UPDATED records admin edits (AUTH-T36)",
  },
  "/update-session": { kind: "exempt", reason: "no writable session fields" },
  "/send-verification-email": {
    kind: "exempt",
    reason: "sends mail only; no account state changes",
  },
  "/verify-password": {
    kind: "exempt",
    reason: "disabled over HTTP (disabledPaths); server-side callers only",
  },
  // SERVER_ONLY: reached only through src/app/api/sgauth/reauth/route.ts.
  "/sgauth/reauth": {
    kind: "audited",
    events: ["REAUTH_SUCCEEDED", "REAUTH_FAILED", "MFA_BACKUP_USED"],
  },
  // The emailed sign-in code (plugins only while SGAUTH_EMAIL_OTP_ENABLED).
  // LOGIN_SUCCESS comes from the session hook; LOGIN_FAILED from the plugin's
  // before and after hooks, through audit-hooks.ts.
  "/sign-in/email-otp": {
    kind: "audited",
    events: ["LOGIN_SUCCESS", "LOGIN_FAILED"],
  },
  "/email-otp/send-verification-otp": {
    kind: "exempt",
    reason:
      "sends mail only; no account state changes. The sign-in it enables is audited at /sign-in/email-otp, and sends are logged with a recipient hash (audit rows carry no PII)",
  },
  "/email-otp/verify-email": { kind: "exempt", reason: NO_EMAIL_OTP_HTTP },
  "/email-otp/check-verification-otp": {
    kind: "exempt",
    reason: NO_EMAIL_OTP_HTTP,
  },
  "/email-otp/request-password-reset": {
    kind: "exempt",
    reason: NO_EMAIL_OTP_HTTP,
  },
  "/forget-password/email-otp": { kind: "exempt", reason: NO_EMAIL_OTP_HTTP },
  "/email-otp/reset-password": { kind: "exempt", reason: NO_EMAIL_OTP_HTTP },
  "/email-otp/request-email-change": {
    kind: "exempt",
    reason: NO_EMAIL_OTP_HTTP,
  },
  "/email-otp/change-email": { kind: "exempt", reason: NO_EMAIL_OTP_HTTP },
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
