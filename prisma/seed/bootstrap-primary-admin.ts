import { z } from "zod";
import { Prisma } from "../../src/generated/prisma/index.js";
import { parseAuditEvent } from "../../src/lib/audit-catalog.js";
import { UsageError } from "./sync-env.js";

// First-Primary-Admin bootstrap, behind scripts/bootstrap-primary-admin.ts.
// It promotes an account that already exists and never creates one, so no
// password passes through the terminal. Like primary-admin.ts it takes its
// client as an argument, because src/lib is `server-only` and bound to the app
// singleton; the audit catalog is the pure part of it. Never reads
// process.env (ENGINEERING §2). See docs/runbooks/launch-checklist.md.

export class BootstrapRefusedError extends Error {}

export type BootstrapArgs = { email: string; apply: boolean };

const emailSchema = z.string().trim().toLowerCase().pipe(z.email());

export function parseBootstrapArgs(argv: string[]): BootstrapArgs {
  let email: string | undefined;
  let apply = false;
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--apply") {
      if (apply) throw new UsageError("--apply was given more than once");
      apply = true;
    } else if (arg === "--email") {
      if (email !== undefined) {
        throw new UsageError("--email was given more than once");
      }
      const value = argv[i + 1];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError("--email needs an address");
      }
      email = value;
      i += 1;
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }
  if (email === undefined) throw new UsageError("--email is required");
  const parsed = emailSchema.safeParse(email);
  if (!parsed.success) throw new UsageError("--email is not a valid address");
  return { email: parsed.data, apply };
}

export type BootstrapState = {
  /** Only the count: never another Primary Admin's email. */
  primaryAdminCount: number;
  target: {
    id: string;
    isAdmin: boolean;
    isPrimaryAdmin: boolean;
    emailVerified: boolean;
    status: string;
  } | null;
  hasCredential: boolean;
  sessionCount: number;
};

export type BootstrapPlan = { userId: string; sessionsToRevoke: number };

type Db = Pick<Prisma.TransactionClient, "user" | "account" | "session">;

export async function readBootstrapState(
  db: Db,
  email: string,
): Promise<BootstrapState> {
  const [primaryAdminCount, target] = await Promise.all([
    db.user.count({ where: { isPrimaryAdmin: true } }),
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
  ]);
  if (!target) {
    return { primaryAdminCount, target, hasCredential: false, sessionCount: 0 };
  }
  const [credential, sessionCount] = await Promise.all([
    db.account.findFirst({
      where: { userId: target.id, providerId: "credential" },
      select: { id: true },
    }),
    db.session.count({ where: { userId: target.id } }),
  ]);
  return {
    primaryAdminCount,
    target,
    hasCredential: credential !== null,
    sessionCount,
  };
}

/** Throws BootstrapRefusedError at the first failing check, in priority order. */
export function planBootstrap(
  state: BootstrapState,
  email: string,
): BootstrapPlan {
  if (state.primaryAdminCount > 0) {
    throw new BootstrapRefusedError(
      "Refusing: a Primary Admin already exists. This script only creates the first one. Use the Primary Admin transfer, or break-glass recovery (npm run recover-primary-admin, AUTH-T39).",
    );
  }
  const { target } = state;
  if (!target) {
    throw new BootstrapRefusedError(
      `No account for ${email}. Sign up at the SGAuth sign-in page with this address, verify the email, then re-run.`,
    );
  }
  if (target.status !== "ACTIVE") {
    throw new BootstrapRefusedError(
      `${email} is ${target.status}. Only an active account can become the Primary Admin.`,
    );
  }
  if (!target.emailVerified) {
    throw new BootstrapRefusedError(
      `${email} has not verified its email address. Finish verification, then re-run.`,
    );
  }
  if (!state.hasCredential) {
    throw new BootstrapRefusedError(
      `${email} has no password set. Finish sign-up, then re-run.`,
    );
  }
  return { userId: target.id, sessionsToRevoke: state.sessionCount };
}

/**
 * Runs inside a caller-owned transaction: re-reads and re-plans, then promotes
 * the user, revokes their sessions and writes the audit row. Callers wrap it in
 * `$transaction(fn, { timeout: 30_000, maxWait: 15_000 })`.
 */
export async function bootstrapInTransaction(
  tx: Prisma.TransactionClient,
  email: string,
): Promise<BootstrapPlan> {
  const plan = planBootstrap(await readBootstrapState(tx, email), email);
  try {
    // One statement: satisfies User_primaryAdmin_requires_admin and rule 3 of
    // protect_primary_admin.
    await tx.user.update({
      where: { id: plan.userId },
      data: { isAdmin: true, isPrimaryAdmin: true },
    });
  } catch (error) {
    if (
      error instanceof Prisma.PrismaClientKnownRequestError &&
      error.code === "P2002"
    ) {
      // one_primary_admin: a concurrent bootstrap won the race.
      throw new BootstrapRefusedError(
        "Another Primary Admin was created while this ran; nothing was written.",
      );
    }
    throw error;
  }
  // The new authority starts from a fresh sign-in.
  const { count } = await tx.session.deleteMany({
    where: { userId: plan.userId },
  });
  await tx.auditEvent.create({
    data: parseAuditEvent({
      type: "PA_BOOTSTRAPPED",
      actorType: "SYSTEM",
      targetType: "USER",
      targetId: plan.userId,
      metadata: { sessionsRevoked: count },
    }),
  });
  return { userId: plan.userId, sessionsToRevoke: count };
}

export function formatBootstrapSummary(
  email: string,
  plan: BootstrapPlan,
): string {
  const lines = [`~ grant admin and Primary Admin to ${email}`];
  if (plan.sessionsToRevoke > 0) {
    lines.push(`- revoke ${plan.sessionsToRevoke} session(s) for ${email}`);
  }
  lines.push("+ audit PA_BOOTSTRAPPED");
  return lines.join("\n");
}
