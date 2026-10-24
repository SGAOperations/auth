import "server-only";
import { Prisma } from "@/generated/prisma/client";
import { writeAuditEvent } from "@/lib/audit";
import type { RecoveryMode } from "@/lib/break-glass/cli";

// Break-glass Primary Admin recovery (docs/runbooks/break-glass.md). Every
// function takes the client it should use and never the app singleton, because
// the only caller is scripts/recover-primary-admin.ts on the migration role.

export class RecoveryRefusal extends Error {}

export class RecoveryStateChanged extends Error {
  constructor() {
    super(
      "The database changed since the plan was shown; nothing was written. Re-run.",
    );
  }
}

export interface RecoveryInput {
  mode: RecoveryMode;
  email: string;
  operator: string;
  reason: string;
  demotePrevious: boolean;
}

interface RecoveryUser {
  id: string;
  email: string;
  status: "ACTIVE" | "DEACTIVATED" | "DELETED";
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  emailVerified: boolean;
  twoFactorEnabled: boolean;
  twoFactorRows: number;
}

export interface RecoveryState {
  target: RecoveryUser | null;
  primaryAdmin: { id: string; email: string } | null;
  inFlightTransfer: { id: string; status: string } | null;
  primaryAdminSessions: number;
  targetSessions: number;
}

export type RecoveryAction =
  | { kind: "cancel_transfer"; transferId: string; status: string }
  | {
      kind: "clear_primary_admin";
      userId: string;
      email: string;
      revokeAdmin: boolean;
    }
  | { kind: "promote"; userId: string; email: string }
  | { kind: "sign_out"; userId: string; email: string; sessions: number }
  | { kind: "remove_mfa"; userId: string; email: string };

export interface RecoveryPlan {
  mode: RecoveryMode;
  actions: RecoveryAction[];
  warnings: string[];
}

export interface RecoveryResult {
  mode: RecoveryMode;
  auditEventId: string;
  recipients: string[];
  sessionsRevoked: number;
  /** The one user who must hold the flag after the change. */
  primaryAdminId: string;
  primaryAdminEmail: string;
  previousPrimaryAdminEmail: string | null;
}

export type RecoveryDb = Prisma.TransactionClient;

export async function readRecoveryState(
  db: RecoveryDb,
  email: string,
): Promise<RecoveryState> {
  const user = await db.user.findUnique({
    where: { email },
    select: {
      id: true,
      email: true,
      status: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      emailVerified: true,
      twoFactorEnabled: true,
      _count: { select: { twoFactors: true } },
    },
  });
  const primaryAdmin = await db.user.findFirst({
    where: { isPrimaryAdmin: true },
    select: { id: true, email: true },
  });
  const inFlightTransfer = await db.primaryAdminTransfer.findFirst({
    where: { status: { in: ["PENDING_ACCEPTANCE", "COOLING"] } },
    select: { id: true, status: true },
  });
  const countSessions = (userId: string | undefined) =>
    userId ? db.session.count({ where: { userId } }) : Promise.resolve(0);

  return {
    target: user && {
      id: user.id,
      email: user.email,
      status: user.status,
      isAdmin: user.isAdmin,
      isPrimaryAdmin: user.isPrimaryAdmin,
      emailVerified: user.emailVerified,
      twoFactorEnabled: user.twoFactorEnabled,
      twoFactorRows: user._count.twoFactors,
    },
    primaryAdmin,
    inFlightTransfer,
    primaryAdminSessions: await countSessions(primaryAdmin?.id),
    targetSessions: await countSessions(user?.id),
  };
}

function hasMfa(user: RecoveryUser): boolean {
  return user.twoFactorEnabled || user.twoFactorRows > 0;
}

/** Decides what a run would do, or throws a RecoveryRefusal saying why not. */
export function planRecovery(
  state: RecoveryState,
  input: Pick<RecoveryInput, "mode" | "email" | "demotePrevious">,
): RecoveryPlan {
  const { target } = state;
  if (!target) throw new RecoveryRefusal(`No user with email ${input.email}.`);
  if (target.status !== "ACTIVE") {
    throw new RecoveryRefusal(
      `${target.email} is ${target.status}; break-glass only promotes an ACTIVE user.`,
    );
  }

  if (input.mode === "reset_mfa") {
    if (!target.isPrimaryAdmin) {
      throw new RecoveryRefusal(
        `${target.email} is not the Primary Admin. Admins reset other users' MFA in the admin UI.`,
      );
    }
    if (!hasMfa(target)) {
      throw new RecoveryRefusal(
        `${target.email} has no MFA enrolled; nothing to reset.`,
      );
    }
    return {
      mode: "reset_mfa",
      actions: [
        { kind: "remove_mfa", userId: target.id, email: target.email },
        {
          kind: "sign_out",
          userId: target.id,
          email: target.email,
          sessions: state.targetSessions,
        },
      ],
      warnings: [],
    };
  }

  if (target.isPrimaryAdmin) {
    throw new RecoveryRefusal(
      `${target.email} is already the Primary Admin. To recover their MFA use --reset-mfa.`,
    );
  }

  const actions: RecoveryAction[] = [];
  const warnings: string[] = [];
  const { primaryAdmin, inFlightTransfer } = state;

  if (inFlightTransfer) {
    actions.push({
      kind: "cancel_transfer",
      transferId: inFlightTransfer.id,
      status: inFlightTransfer.status,
    });
  }
  if (primaryAdmin) {
    // Old Primary Admin first: the unique index cannot be deferred.
    actions.push({
      kind: "clear_primary_admin",
      userId: primaryAdmin.id,
      email: primaryAdmin.email,
      revokeAdmin: input.demotePrevious,
    });
  } else {
    warnings.push("there is no current Primary Admin");
  }
  actions.push({ kind: "promote", userId: target.id, email: target.email });
  if (primaryAdmin) {
    actions.push({
      kind: "sign_out",
      userId: primaryAdmin.id,
      email: primaryAdmin.email,
      sessions: state.primaryAdminSessions,
    });
  }

  if (!hasMfa(target)) {
    warnings.push(
      `${target.email} has no MFA; they must enrol TOTP before any admin action`,
    );
  }
  if (!target.emailVerified) {
    warnings.push(`${target.email} has not verified their email address`);
  }
  if (!target.isAdmin) {
    warnings.push(`${target.email} is not an admin yet; they will become one`);
  }
  return { mode: "transfer", actions, warnings };
}

function sessionsLabel(count: number): string {
  return `${count} ${count === 1 ? "session" : "sessions"}`;
}

/** One line per action, then the warnings. Never prints tokens or secrets. */
export function formatRecoveryPlan(plan: RecoveryPlan): string {
  const lines = [
    plan.mode === "transfer"
      ? "Break-glass: transfer Primary Admin"
      : "Break-glass: reset Primary Admin MFA",
  ];
  for (const action of plan.actions) {
    switch (action.kind) {
      case "cancel_transfer":
        lines.push(
          `! cancel in-flight transfer ${action.transferId} (${action.status})`,
        );
        break;
      case "clear_primary_admin":
        lines.push(
          `- clear Primary Admin from ${action.email} (${action.revokeAdmin ? "admin revoked" : "stays admin"})`,
        );
        break;
      case "promote":
        lines.push(`+ make ${action.email} admin and Primary Admin`);
        break;
      case "sign_out":
        lines.push(
          `x sign out ${action.email} (${sessionsLabel(action.sessions)})`,
        );
        break;
      case "remove_mfa":
        lines.push(`x remove TOTP and backup codes for ${action.email}`);
        break;
    }
  }
  for (const warning of plan.warnings) lines.push(`warning: ${warning}`);
  return lines.join("\n");
}

// What a plan does, ignoring session counts: a login between the dry look and
// the write is not a reason to refuse.
function planSignature(plan: RecoveryPlan): string {
  return JSON.stringify(
    plan.actions.map((action) =>
      action.kind === "sign_out" ? { ...action, sessions: 0 } : action,
    ),
  );
}

const lockUsers = (db: RecoveryDb, ids: string[]) =>
  db.$queryRaw`SELECT "id" FROM "User" WHERE "id" IN (${Prisma.join(ids)}) ORDER BY "id" FOR UPDATE`;

const lockTransfer = (db: RecoveryDb, id: string) =>
  db.$queryRaw`SELECT "id" FROM "PrimaryAdminTransfer" WHERE "id" = ${id} FOR UPDATE`;

/**
 * Writes the plan inside the caller's transaction. Re-reads and re-plans under
 * row locks, and throws RecoveryStateChanged when that differs from the plan
 * the operator confirmed.
 */
export async function applyRecovery(
  tx: RecoveryDb,
  input: RecoveryInput,
  shownPlan: RecoveryPlan,
): Promise<RecoveryResult> {
  if (input.mode === "transfer") {
    // Transaction-local (the `true`), never a plain SET: a pooled connection
    // would carry the variable to the next client.
    await tx.$queryRaw`SELECT set_config('sgauth.pa_transfer', 'on', true)`;
  }

  const before = await readRecoveryState(tx, input.email);
  const ids = [before.target?.id, before.primaryAdmin?.id].filter(
    (id): id is string => id !== undefined,
  );
  if (ids.length > 0) await lockUsers(tx, [...new Set(ids)]);
  if (before.inFlightTransfer) {
    await lockTransfer(tx, before.inFlightTransfer.id);
  }

  const state = await readRecoveryState(tx, input.email);
  const plan = planRecovery(state, input);
  if (planSignature(plan) !== planSignature(shownPlan)) {
    throw new RecoveryStateChanged();
  }
  const target = state.target;
  if (!target) throw new RecoveryStateChanged();

  let sessionsRevoked = 0;
  let cancelledTransferId: string | undefined;
  for (const action of plan.actions) {
    switch (action.kind) {
      case "cancel_transfer":
        // cancelledById stays null: there is no acting user to record.
        await tx.primaryAdminTransfer.update({
          where: { id: action.transferId },
          data: { status: "CANCELLED", cancelledAt: new Date() },
        });
        cancelledTransferId = action.transferId;
        break;
      case "clear_primary_admin":
        await tx.user.update({
          where: { id: action.userId },
          data: {
            isPrimaryAdmin: false,
            ...(action.revokeAdmin ? { isAdmin: false } : {}),
          },
        });
        break;
      case "promote":
        await tx.user.update({
          where: { id: action.userId },
          data: { isAdmin: true, isPrimaryAdmin: true },
        });
        break;
      case "sign_out": {
        const { count } = await tx.session.deleteMany({
          where: { userId: action.userId },
        });
        sessionsRevoked += count;
        break;
      }
      case "remove_mfa":
        await tx.twoFactor.deleteMany({ where: { userId: action.userId } });
        await tx.user.update({
          where: { id: action.userId },
          data: { twoFactorEnabled: false },
        });
        break;
    }
  }

  const previous = state.primaryAdmin;
  const audit = await writeAuditEvent(tx, {
    type: "BREAK_GLASS_PA_RECOVERY",
    actorType: "BREAK_GLASS",
    targetType: "USER",
    targetId: target.id,
    metadata:
      plan.mode === "transfer"
        ? {
            mode: "transfer",
            operator: input.operator,
            reason: input.reason,
            previousPrimaryAdminId: previous?.id ?? null,
            previousAdminRevoked: previous !== null && input.demotePrevious,
            ...(cancelledTransferId ? { cancelledTransferId } : {}),
            sessionsRevoked,
          }
        : {
            mode: "reset_mfa",
            operator: input.operator,
            reason: input.reason,
            sessionsRevoked,
          },
    ip: null,
    userAgent: null,
  });

  const admins = await tx.user.findMany({
    where: { isAdmin: true, status: "ACTIVE" },
    select: { email: true },
  });
  const previousEmail =
    plan.mode === "transfer" ? (previous?.email ?? null) : null;
  const recipients = new Map<string, string>();
  for (const { email } of admins) recipients.set(email.toLowerCase(), email);
  if (previousEmail) recipients.set(previousEmail.toLowerCase(), previousEmail);

  return {
    mode: plan.mode,
    auditEventId: audit.id,
    recipients: [...recipients.values()].sort(),
    sessionsRevoked,
    primaryAdminId: target.id,
    primaryAdminEmail: target.email,
    previousPrimaryAdminEmail: previousEmail,
  };
}

/**
 * Runs after commit, on a fresh read. Throws when the committed state is not
 * what the recovery promised.
 */
export async function verifyRecovery(
  db: RecoveryDb,
  result: RecoveryResult,
): Promise<{ primaryAdminEmail: string }> {
  const primaryAdmins = await db.user.findMany({
    where: { isPrimaryAdmin: true },
    select: { id: true, email: true },
  });
  const [only] = primaryAdmins;
  if (primaryAdmins.length !== 1 || only.id !== result.primaryAdminId) {
    throw new Error(
      `Expected exactly one Primary Admin (${result.primaryAdminEmail}) but found ${primaryAdmins.length}.`,
    );
  }
  const audit = await db.auditEvent.findUnique({
    where: { id: result.auditEventId },
    select: { type: true },
  });
  if (audit?.type !== "BREAK_GLASS_PA_RECOVERY") {
    throw new Error(`Audit event ${result.auditEventId} was not found.`);
  }
  if (result.mode === "reset_mfa") {
    const remaining = await db.twoFactor.count({
      where: { userId: result.primaryAdminId },
    });
    if (remaining > 0) {
      throw new Error(`${remaining} TOTP enrolment(s) remain after the reset.`);
    }
  }
  return { primaryAdminEmail: only.email };
}
