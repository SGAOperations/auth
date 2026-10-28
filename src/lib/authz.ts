// No `import "server-only"`: this module touches no database, secret or
// environment variable (ENGINEERING.md §3), and the UI must call the same
// function to hide controls. Enforcement is still server-side only.
import type { User } from "@/generated/prisma/client";

/** The columns of a User row that the rule matrix reads. A Prisma `User` row is assignable. */
export type AuthzSubject = Pick<
  User,
  "id" | "isAdmin" | "isPrimaryAdmin" | "status"
>;

/** Actions that act on a user. They need a target. */
export const USER_ACTIONS = [
  "grantAdmin",
  "revokeAdmin",
  "deactivate",
  "reactivate",
  "delete",
  "updateProfile",
  "assignPosition",
  "unassignPosition",
  "changeEmail",
  "resetMfa",
  "revokeSessions",
  "unlock",
  "resendInvite",
  "initiateTransfer",
] as const;

/** Actions that act on no particular user. */
export const GLOBAL_ACTIONS = [
  "accessAdmin",
  "managePositions",
  "manageProducts",
] as const;

export type UserAction = (typeof USER_ACTIONS)[number];
export type GlobalAction = (typeof GLOBAL_ACTIONS)[number];
export type AuthzAction = UserAction | GlobalAction;

export type AuthzDenialReason =
  | "ACTOR_INACTIVE"
  | "NOT_ADMIN"
  | "SELF_MODIFICATION"
  | "PRIMARY_ADMIN_PROTECTED"
  | "PRIMARY_ADMIN_REQUIRED"
  | "TARGET_NOT_ELIGIBLE"
  | "NOT_TRANSFER_RECIPIENT"
  | "NOT_TRANSFER_INITIATOR";

export type AuthzDecision =
  | { allowed: true }
  | { allowed: false; reason: AuthzDenialReason };

/** Nobody may do these to themselves. */
const SELF_PROTECTED: ReadonlySet<UserAction> = new Set([
  "grantAdmin",
  "revokeAdmin",
  "deactivate",
  "reactivate",
  "delete",
  "initiateTransfer",
]);

/** Only the transfer flow or break-glass may do these to the Primary Admin. */
const PA_PROTECTED: ReadonlySet<UserAction> = new Set([
  "grantAdmin",
  "revokeAdmin",
  "deactivate",
  "reactivate",
  "delete",
  "resetMfa",
  "changeEmail",
]);

/** On an admin target, only the Primary Admin may do these. */
const PA_ONLY_ON_ADMINS: ReadonlySet<UserAction> = new Set([
  "changeEmail",
  "resetMfa",
]);

function isGlobalAction(action: AuthzAction): action is GlobalAction {
  return (GLOBAL_ACTIONS as readonly string[]).includes(action);
}

const allow: AuthzDecision = { allowed: true };

function deny(reason: AuthzDenialReason): AuthzDecision {
  return { allowed: false, reason };
}

/**
 * Whether `actor` may perform `action`, optionally on `target`. Pure: callers
 * load the rows and pass them in. A denial is an expected outcome (the endpoint
 * answers 403 with the reason). A missing target for a user action is a
 * programming error and throws.
 *
 * The first matching rule wins. The Primary Admin is `isAdmin && isPrimaryAdmin`.
 */
export function can(actor: AuthzSubject, action: GlobalAction): AuthzDecision;
export function can(
  actor: AuthzSubject,
  action: UserAction,
  target: AuthzSubject,
): AuthzDecision;
export function can(
  actor: AuthzSubject,
  action: AuthzAction,
  target?: AuthzSubject,
): AuthzDecision {
  if (actor.status !== "ACTIVE") {
    return deny("ACTOR_INACTIVE");
  }
  if (!actor.isAdmin) {
    return deny("NOT_ADMIN");
  }
  if (isGlobalAction(action)) {
    return allow;
  }
  if (!target) {
    throw new Error(`can(): ${action} requires a target`);
  }

  const actorIsPrimaryAdmin = actor.isPrimaryAdmin;
  const self = actor.id === target.id;
  if (self && SELF_PROTECTED.has(action)) {
    return deny("SELF_MODIFICATION");
  }

  if (action === "initiateTransfer") {
    if (!actorIsPrimaryAdmin) {
      return deny("PRIMARY_ADMIN_REQUIRED");
    }
    if (!target.isAdmin || target.status !== "ACTIVE") {
      return deny("TARGET_NOT_ELIGIBLE");
    }
    return allow;
  }

  if (target.isPrimaryAdmin && PA_PROTECTED.has(action)) {
    // The Primary Admin changes their own email; their MFA reset is break-glass only.
    if (!(self && action === "changeEmail")) {
      return deny("PRIMARY_ADMIN_PROTECTED");
    }
  }

  if (target.isAdmin && PA_ONLY_ON_ADMINS.has(action) && !actorIsPrimaryAdmin) {
    return deny("PRIMARY_ADMIN_REQUIRED");
  }

  return allow;
}

/** The two people a Primary Admin transfer names. */
export type TransferParties = { fromUserId: string; toUserId: string };

/**
 * Whether `actor` may act on a transfer that already exists. Initiating one is
 * `can(actor, "initiateTransfer", recipient)`. Only the recipient accepts or
 * declines; only the sender, and only while still the Primary Admin, cancels.
 * Whether the transfer's state allows the action is the state machine's call.
 */
export function canActOnTransfer(
  actor: AuthzSubject,
  transfer: TransferParties,
  action: "accept" | "decline" | "cancel",
): AuthzDecision {
  if (actor.status !== "ACTIVE") {
    return deny("ACTOR_INACTIVE");
  }
  if (!actor.isAdmin) {
    return deny("NOT_ADMIN");
  }
  if (action === "cancel") {
    return actor.id === transfer.fromUserId && actor.isPrimaryAdmin
      ? allow
      : deny("NOT_TRANSFER_INITIATOR");
  }
  return actor.id === transfer.toUserId
    ? allow
    : deny("NOT_TRANSFER_RECIPIENT");
}
