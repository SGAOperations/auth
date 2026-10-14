import { hashPassword } from "better-auth/crypto";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/index.js";

// Standalone module used by prisma/seed.ts, local environment only. Like
// positions.ts it takes its client as an argument, because src/lib is
// `server-only` and bound to the app singleton.

export type PrimaryAdminInput = {
  email: string;
  password: string;
  name: string;
};

export type PrimaryAdminState = {
  target: {
    id: string;
    isAdmin: boolean;
    isPrimaryAdmin: boolean;
    emailVerified: boolean;
    status: string;
  } | null;
  hasCredential: boolean;
  /** Every Primary Admin other than the target. */
  others: Array<{ id: string; email: string }>;
};

export type PrimaryAdminAction =
  | { type: "demote-other"; id: string; email: string }
  | { type: "create-user" }
  | { type: "promote" }
  | { type: "create-credential" };

export type PrimaryAdminPlan = {
  /** In the order they must be applied. */
  actions: PrimaryAdminAction[];
  /** The target already had a password, which is never overwritten. */
  credentialExisted: boolean;
};

export class PrimaryAdminSeedError extends Error {}

type Reader = Pick<Prisma.TransactionClient, "user" | "account">;

export async function readPrimaryAdminState(
  db: Reader,
  email: string,
): Promise<PrimaryAdminState> {
  const [target, primaryAdmins] = await Promise.all([
    db.user.findUnique({
      where: { email },
      select: {
        id: true,
        isAdmin: true,
        isPrimaryAdmin: true,
        emailVerified: true,
        status: true,
      },
    }),
    db.user.findMany({
      where: { isPrimaryAdmin: true },
      select: { id: true, email: true },
    }),
  ]);
  const credential = target
    ? await db.account.findFirst({
        where: { userId: target.id, providerId: "credential" },
        select: { id: true },
      })
    : null;
  return {
    target,
    hasCredential: credential !== null,
    others: primaryAdmins.filter((user) => user.id !== target?.id),
  };
}

export function planPrimaryAdmin(
  state: PrimaryAdminState,
  input: PrimaryAdminInput,
): PrimaryAdminPlan {
  const { target } = state;
  if (target && target.status !== "ACTIVE") {
    throw new PrimaryAdminSeedError(
      `${input.email} exists but is ${target.status}. Use another SEED_PRIMARY_ADMIN_EMAIL, or reactivate the user first.`,
    );
  }

  const actions: PrimaryAdminAction[] = state.others.map((other) => ({
    type: "demote-other",
    id: other.id,
    email: other.email,
  }));

  if (!target) {
    actions.push({ type: "create-user" });
  } else if (
    !target.isAdmin ||
    !target.isPrimaryAdmin ||
    !target.emailVerified
  ) {
    actions.push({ type: "promote" });
  }

  if (!state.hasCredential) actions.push({ type: "create-credential" });

  return { actions, credentialExisted: state.hasCredential };
}

/**
 * Applies the plan in one transaction, re-planned from a re-read inside it.
 * Never overwrites an existing password. Returns the plan that was applied.
 */
export async function applyPrimaryAdmin(
  db: PrismaClient,
  input: PrimaryAdminInput,
): Promise<PrimaryAdminPlan> {
  // Hashed up front: scrypt is slow and must not hold the transaction open.
  const passwordHash = await hashPassword(input.password);

  return db.$transaction(
    async (tx) => {
      const state = await readPrimaryAdminState(tx, input.email);
      const plan = planPrimaryAdmin(state, input);

      let userId = state.target?.id;
      for (const action of plan.actions) {
        if (action.type === "demote-other") {
          await tx.user.update({
            where: { id: action.id },
            data: { isPrimaryAdmin: false },
          });
        } else if (action.type === "create-user") {
          const created = await tx.user.create({
            data: {
              email: input.email,
              name: input.name,
              emailVerified: true,
              isAdmin: true,
              isPrimaryAdmin: true,
              status: "ACTIVE",
            },
            select: { id: true },
          });
          userId = created.id;
        } else if (action.type === "promote" && userId) {
          await tx.user.update({
            where: { id: userId },
            data: { isAdmin: true, isPrimaryAdmin: true, emailVerified: true },
          });
        } else if (action.type === "create-credential" && userId) {
          // The shape Better Auth's own sign-up writes.
          await tx.account.create({
            data: {
              userId,
              providerId: "credential",
              accountId: userId,
              password: passwordHash,
            },
          });
          await tx.user.update({
            where: { id: userId },
            data: { passwordChangedAt: new Date() },
          });
        }
      }
      return plan;
    },
    { timeout: 30_000, maxWait: 15_000 },
  );
}

/** One line per action. Never contains the password or the hash. */
export function formatPrimaryAdminSummary(
  email: string,
  plan: PrimaryAdminPlan,
): string {
  const lines: string[] = [];
  for (const action of plan.actions) {
    if (action.type === "create-user") {
      lines.push(`+ create Primary Admin ${email}`);
    } else if (action.type === "promote") {
      lines.push(`~ promote ${email} to Primary Admin`);
    } else if (action.type === "demote-other") {
      lines.push(`- clear Primary Admin from ${action.email}`);
    } else {
      lines.push(`+ set password for ${email}`);
    }
  }
  if (plan.credentialExisted) {
    lines.push(
      `= ${email} already has a password; SEED_PRIMARY_ADMIN_PASSWORD was not applied.`,
    );
  }
  if (plan.actions.length === 0) {
    lines.push(`Primary Admin ${email} already seeded; nothing changed.`);
  }
  return lines.join("\n");
}
