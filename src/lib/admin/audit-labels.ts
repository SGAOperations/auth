import { AUDIT_EVENT_TYPES, type AuditEventType } from "@/lib/audit-catalog";

// Pure and client-safe. Exhaustive over the catalog, so a new event type fails
// the typecheck until the timeline can name it.
export const AUDIT_LABELS: Record<AuditEventType, string> = {
  LOGIN_SUCCESS: "Signed in",
  LOGIN_FAILED: "Failed sign-in",
  LOGOUT: "Signed out",
  SESSION_REVOKED: "Session revoked",
  SESSIONS_REVOKED: "Signed out everywhere",
  PASSWORD_RESET_REQUESTED: "Password reset requested",
  PASSWORD_RESET: "Password reset",
  PASSWORD_SET_REQUESTED: "Set-password link requested",
  PASSWORD_SET: "Password set",
  PASSWORD_CHANGED: "Password changed",
  PASSWORD_CHANGE_FAILED: "Password change failed",
  PASSWORD_REHASHED: "Password re-hashed",
  EMAIL_VERIFIED: "Email verified",
  USER_CREATED: "Account created",
  USER_INVITED: "Invite sent",
  USER_UPDATED: "Profile updated",
  USER_DEACTIVATED: "Deactivated",
  USER_REACTIVATED: "Reactivated",
  USER_DELETED: "Deleted",
  ADMIN_GRANTED: "Admin access granted",
  ADMIN_REVOKED: "Admin access removed",
  POSITION_CREATED: "Position created",
  POSITION_UPDATED: "Position updated",
  POSITION_DELETED: "Position deleted",
  POSITION_ASSIGNED: "Position assigned",
  POSITION_UNASSIGNED: "Position removed",
  PRODUCT_CREATED: "Product created",
  PRODUCT_UPDATED: "Product updated",
  PRODUCT_DELETED: "Product deleted",
  PRODUCT_API_KEY_CREATED: "Product API key created",
  PRODUCT_API_KEY_REVOKED: "Product API key revoked",
  PA_TRANSFER_INITIATED: "Primary Admin transfer started",
  PA_TRANSFER_ACCEPTED: "Primary Admin transfer accepted",
  PA_TRANSFER_CANCELLED: "Primary Admin transfer cancelled",
  PA_TRANSFER_COMPLETED: "Primary Admin transfer completed",
  PA_TRANSFER_EXPIRED: "Primary Admin transfer expired",
  PA_BOOTSTRAPPED: "Made Primary Admin",
  BREAK_GLASS_PA_RECOVERY: "Break-glass recovery",
  ACCOUNT_LOCKED: "Account locked",
  ACCOUNT_UNLOCKED: "Account unlocked",
  MFA_ENROLLED: "Two-factor enrolled",
  MFA_DISABLED: "Two-factor turned off",
  MFA_RESET: "Two-factor reset",
  MFA_BACKUP_USED: "Backup code used",
  MFA_BACKUP_CODES_REGENERATED: "Backup codes regenerated",
  REAUTH_SUCCEEDED: "Confirmed identity",
  REAUTH_FAILED: "Failed identity check",
  PASSKEY_ADDED: "Passkey added",
  PASSKEY_REMOVED: "Passkey removed",
  SLACK_LINKED: "Slack linked",
  SLACK_UNLINKED: "Slack unlinked",
  BULK_IMPORT: "Bulk import",
  JWKS_ROTATED: "Signing keys rotated",
  AUDIT_EXPORTED: "Audit log exported",
  EMAIL_CHANGE_REQUESTED: "Email change requested",
  EMAIL_CHANGED: "Email changed",
};

const KNOWN = new Set<string>(AUDIT_EVENT_TYPES);

/** The readable label, or the raw type for one that predates the catalog. */
export function auditLabel(type: string): string {
  return KNOWN.has(type) ? AUDIT_LABELS[type as AuditEventType] : type;
}

const FIELD_LABELS: Record<string, string> = {
  name: "name",
  preferredName: "preferred name",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * The one detail worth a line under an event: the changed fields of a profile
 * edit, or how many sessions a deactivation ended. `positionName` is the name
 * the caller resolved for a position event's `positionId`.
 */
export function auditDetail(
  type: string,
  metadata: unknown,
  positionName?: string | null,
): string | null {
  if (!isRecord(metadata)) return null;
  if (type === "USER_UPDATED" && Array.isArray(metadata.fields)) {
    const fields = metadata.fields
      .filter((field): field is string => typeof field === "string")
      .map((field) => FIELD_LABELS[field] ?? field);
    return fields.length > 0 ? `Changed ${fields.join(" and ")}` : null;
  }
  if (
    type === "USER_DEACTIVATED" &&
    typeof metadata.revokedSessions === "number"
  ) {
    const count = metadata.revokedSessions;
    return `${count} ${count === 1 ? "session" : "sessions"} ended`;
  }
  if (
    (type === "POSITION_ASSIGNED" || type === "POSITION_UNASSIGNED") &&
    positionName
  ) {
    return positionName;
  }
  return null;
}
