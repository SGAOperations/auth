import "server-only";
import type { MutationSpec } from "@/lib/admin/users/handlers";
import type { UserTarget } from "@/lib/admin/users/queries";
import type { AdminUserAction } from "@/lib/admin/users/schemas";
import { audit } from "@/lib/audit";

// The eight POST actions. Every state change is a conditional `updateMany`
// whose `where` restates its precondition, so a lost race reads as a conflict
// and commits nothing. The handlers refuse a tombstone up front; `live` repeats
// that for a delete that lands between the load and the write.
const live = (id: string) => ({ id, status: { not: "DELETED" } }) as const;

const displayName = (target: UserTarget) => target.preferredName ?? target.name;

type Run = MutationSpec["run"];

const deactivate: Run = async ({ tx, target, now }) => {
  const changed = await tx.user.updateMany({
    where: { id: target.id, status: "ACTIVE" },
    data: { status: "DEACTIVATED", deactivatedAt: now },
  });
  if (changed.count === 0) return { fail: "ALREADY_DEACTIVATED" };
  // Prisma, not Better Auth, so its session hooks add no second audit row.
  const { count: revokedSessions } = await tx.session.deleteMany({
    where: { userId: target.id },
  });
  await audit({
    type: "USER_DEACTIVATED",
    targetType: "USER",
    targetId: target.id,
    metadata: { revokedSessions },
  });
  return { userId: target.id, extra: { revokedSessions } };
};

const reactivate: Run = async ({ tx, target }) => {
  const changed = await tx.user.updateMany({
    where: { id: target.id, status: "DEACTIVATED" },
    data: { status: "ACTIVE", deactivatedAt: null },
  });
  if (changed.count === 0) return { fail: "NOT_DEACTIVATED" };
  await audit({
    type: "USER_REACTIVATED",
    targetType: "USER",
    targetId: target.id,
  });
  return { userId: target.id };
};

const grantAdmin: Run = async ({ tx, target, now }, deps) => {
  const changed = await tx.user.updateMany({
    where: { ...live(target.id), isAdmin: false },
    data: { isAdmin: true },
  });
  if (changed.count === 0) return { fail: "ALREADY_ADMIN" };
  await audit({
    type: "ADMIN_GRANTED",
    targetType: "USER",
    targetId: target.id,
  });
  return {
    userId: target.id,
    send: () =>
      deps.mailer.sendEmail({
        to: target.email,
        template: "security-notice",
        data: {
          name: displayName(target),
          event: "admin-granted",
          occurredAt: now,
        },
      }),
  };
};

const revokeAdmin: Run = async ({ tx, target }) => {
  const changed = await tx.user.updateMany({
    where: { ...live(target.id), isAdmin: true },
    data: { isAdmin: false },
  });
  if (changed.count === 0) return { fail: "NOT_AN_ADMIN" };
  await audit({
    type: "ADMIN_REVOKED",
    targetType: "USER",
    targetId: target.id,
  });
  return { userId: target.id };
};

const revokeSessions: Run = async ({ tx, target }) => {
  const { count: revokedSessions } = await tx.session.deleteMany({
    where: { userId: target.id },
  });
  await audit({
    type: "SESSIONS_REVOKED",
    targetType: "USER",
    targetId: target.id,
    metadata: { scope: "all" },
  });
  return { userId: target.id, extra: { revokedSessions } };
};

const unlock: Run = async ({ tx, target, now }, deps) => {
  const { wasLocked } = await deps.clearAccountLock(tx, {
    userId: target.id,
    now,
  });
  if (!wasLocked) return { fail: "NOT_LOCKED" };
  await audit({
    type: "ACCOUNT_UNLOCKED",
    targetType: "USER",
    targetId: target.id,
    metadata: { method: "admin" },
  });
  return { userId: target.id };
};

const resetMfa: Run = async ({ tx, target, now }, deps) => {
  const changed = await tx.user.updateMany({
    where: { ...live(target.id), twoFactorEnabled: true },
    data: { twoFactorEnabled: false },
  });
  if (changed.count === 0) return { fail: "MFA_NOT_ENROLLED" };
  await tx.twoFactor.deleteMany({ where: { userId: target.id } });
  await audit({
    type: "MFA_RESET",
    targetType: "USER",
    targetId: target.id,
  });
  return {
    userId: target.id,
    send: () =>
      deps.mailer.sendEmail({
        to: target.email,
        template: "security-notice",
        data: {
          name: displayName(target),
          event: "mfa-reset",
          occurredAt: now,
        },
      }),
  };
};

const resendInvite: Run = async ({ tx, target, now }, deps) => {
  if (target.status !== "ACTIVE") return { fail: "USER_DEACTIVATED" };
  if (target.hasPassword) return { fail: "PASSWORD_ALREADY_SET" };
  const invite = await deps.issueAdminInvite(tx, { userId: target.id, now });
  if (!invite.ok) return { fail: "INVITE_LIMIT" };
  await audit({
    type: "USER_INVITED",
    targetType: "USER",
    targetId: target.id,
  });
  return {
    userId: target.id,
    send: () =>
      deps.mailer.sendEmail({
        to: target.email,
        template: "set-password",
        data: {
          name: displayName(target),
          url: invite.url,
          expiresInMinutes: invite.expiresInMinutes,
          kind: "admin-invite",
        },
      }),
  };
};

/**
 * `authz` is the per-target `can()` action. Re-authentication is asked only for
 * the actions that need it, and only after `can()` has allowed them.
 */
export const ACTION_SPECS: Record<AdminUserAction, MutationSpec> = {
  deactivate: { authz: "deactivate", freshAuth: true, run: deactivate },
  reactivate: { authz: "reactivate", freshAuth: false, run: reactivate },
  "grant-admin": { authz: "grantAdmin", freshAuth: true, run: grantAdmin },
  "revoke-admin": { authz: "revokeAdmin", freshAuth: true, run: revokeAdmin },
  "revoke-sessions": {
    authz: "revokeSessions",
    freshAuth: false,
    run: revokeSessions,
  },
  unlock: { authz: "unlock", freshAuth: false, run: unlock },
  "reset-mfa": { authz: "resetMfa", freshAuth: true, run: resetMfa },
  "resend-invite": {
    authz: "resendInvite",
    freshAuth: false,
    run: resendInvite,
  },
};
