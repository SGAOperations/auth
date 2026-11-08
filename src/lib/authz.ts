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
  | "NOT_SELF"
  | "NOT_TRANSFER_RECIPIENT"
  | "NOT_TRANSFER_INITIATOR"
  | "NOT_ACCESS_SUBMITTER"
  | "NOT_LEADERSHIP"
  | "NOT_ACCESS_VIEWER";

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

/**
 * No other admin may do these to the Primary Admin (BT13: no signing them out
 * in a loop, clearing their lock or renaming them). Only the transfer flow or
 * break-glass changes the role itself.
 */
const PA_PROTECTED: ReadonlySet<UserAction> = new Set([
  "grantAdmin",
  "revokeAdmin",
  "deactivate",
  "reactivate",
  "delete",
  "resetMfa",
  "changeEmail",
  "revokeSessions",
  "unlock",
  "updateProfile",
  "resendInvite",
]);

/** The PA_PROTECTED actions the Primary Admin may still do to themselves. */
const PA_SELF_SERVICE: ReadonlySet<UserAction> = new Set([
  "changeEmail",
  "revokeSessions",
  "unlock",
  "updateProfile",
  "resendInvite",
]);

/**
 * On an admin target, only the Primary Admin may do these. `revokeAdmin` is
 * here because revoke, then reset MFA and change the email of the now
 * non-admin, is an admin-on-admin takeover (BT4). Every admin a revoke can
 * succeed on is an admin target, so only the Primary Admin revokes admin.
 */
const PA_ONLY_ON_ADMINS: ReadonlySet<UserAction> = new Set([
  "changeEmail",
  "resetMfa",
  "revokeAdmin",
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
    // The Primary Admin manages their own email, sessions, lock, profile and
    // invite; their MFA reset is break-glass only.
    if (!(self && PA_SELF_SERVICE.has(action))) {
      return deny("PRIMARY_ADMIN_PROTECTED");
    }
  }

  if (target.isAdmin && PA_ONLY_ON_ADMINS.has(action) && !actorIsPrimaryAdmin) {
    return deny("PRIMARY_ADMIN_REQUIRED");
  }

  return allow;
}

/**
 * Whether `actor` may edit their own name and preferred name from the account
 * page. Any ACTIVE user may, for themselves only; an admin editing someone
 * else's profile is `can(actor, "updateProfile", target)`.
 */
export function canUpdateOwnProfile(
  actor: AuthzSubject,
  targetUserId: string,
): AuthzDecision {
  if (actor.status !== "ACTIVE") {
    return deny("ACTOR_INACTIVE");
  }
  return actor.id === targetUserId ? allow : deny("NOT_SELF");
}

/**
 * Whether `actor` may view the position org chart. Any ACTIVE user may: the
 * chart shows structure only (name, category, leadership flag) and carries no
 * holders, keys or counts.
 */
export function canViewOrgChart(actor: AuthzSubject): AuthzDecision {
  return actor.status === "ACTIVE" ? allow : deny("ACTOR_INACTIVE");
}

/**
 * Whether `actor` may use SGAssist's `/who-is` (#349). Unlike the org chart,
 * `/who-is` shows who holds which positions. Any ACTIVE user may (decision 1,
 * #349). It is a separate function so the rule can tighten without touching
 * `canViewOrgChart`.
 */
export function canUseWhoIs(actor: AuthzSubject): AuthzDecision {
  return actor.status === "ACTIVE" ? allow : deny("ACTOR_INACTIVE");
}

/**
 * Whether `actor` may submit an access request from Slack: they must hold at
 * least one position on the submitter list. Admin status grants nothing, and an
 * empty list denies everyone. Keys match exactly.
 *
 * Both key lists must hold active positions only. Active keys are unique
 * (`Position_key_active_key`), so a reused key cannot match a retired position.
 */
export function canSubmitAccessRequest(
  actor: AuthzSubject,
  heldPositionKeys: readonly string[],
  submitterPositionKeys: readonly string[],
): AuthzDecision {
  if (actor.status !== "ACTIVE") {
    return deny("ACTOR_INACTIVE");
  }
  const submitters = new Set(submitterPositionKeys);
  return heldPositionKeys.some((key) => submitters.has(key))
    ? allow
    : deny("NOT_ACCESS_SUBMITTER");
}

/** The positions whose holders may see the access requests page (#344). */
export const ACCESS_REQUEST_VIEWER_KEYS = [
  "executive-vice-president",
  "vice-president-of-operational-affairs",
  "information-manager",
] as const;

/**
 * Whether `actor` may see the access requests: an ACTIVE user who holds at
 * least one of `ACCESS_REQUEST_VIEWER_KEYS`. Admin status grants nothing. Keys
 * match exactly, and the caller passes the keys of non-deleted positions only,
 * the same contract as `canSubmitAccessRequest`.
 */
export function canViewAccessRequests(
  actor: AuthzSubject,
  heldPositionKeys: readonly string[],
): AuthzDecision {
  if (actor.status !== "ACTIVE") {
    return deny("ACTOR_INACTIVE");
  }
  const viewers: readonly string[] = ACCESS_REQUEST_VIEWER_KEYS;
  return heldPositionKeys.some((key) => viewers.includes(key))
    ? allow
    : deny("NOT_ACCESS_VIEWER");
}

/**
 * Whether `actor` may see the leadership resources and guides: an ACTIVE user
 * who holds at least one non-deleted leadership position. Admin status does not
 * grant access. `viewer.isLeadership` comes from `loadAccountOverview`, which
 * counts non-deleted positions only.
 */
export function canViewLeadershipResources(
  actor: AuthzSubject,
  viewer: { isLeadership: boolean },
): AuthzDecision {
  if (actor.status !== "ACTIVE") {
    return deny("ACTOR_INACTIVE");
  }
  return viewer.isLeadership ? allow : deny("NOT_LEADERSHIP");
}

/**
 * Whether `actor` may let SGAuth edit their Slack profile (#358): an ACTIVE
 * user who holds a non-deleted leadership position, the same rule as the
 * leadership resources. Only the grant is gated. Withdrawing is self-only and
 * never checks leadership, so consent can always be taken back.
 */
export function canGrantSlackProfileAccess(
  actor: AuthzSubject,
  viewer: { isLeadership: boolean },
): AuthzDecision {
  return canViewLeadershipResources(actor, viewer);
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
