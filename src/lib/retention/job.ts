import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { withAuditAnonymization } from "@/lib/audit";
import type { Mailer } from "@/lib/email/mailer";
import { logger } from "@/lib/log";
import type { Logger } from "@/lib/log/logger";
import {
  cutoffs,
  inactivityDeadline,
  inactivityReference,
  NOTICE_BATCH,
  noticeIsCurrent,
  TOMBSTONE_BATCH,
} from "@/lib/retention/policy";
import { displayName } from "@/lib/user-display";
import { tombstoneUser, type TombstoneInput } from "@/lib/users/tombstone";

// The daily retention job (docs/DATA_HANDLING.md, Retention). Every threshold
// is in policy.ts. The steps run in a fixed order and a failing step is counted
// and logged without stopping the next one, so one bad row cannot leave the
// session purge undone.
//
// Dry run: every step selects exactly what a real run would, then counts it and
// writes nothing: no update, no delete, no email, no audit row. The counts are
// "would do" counts.
//
// Concurrency: nothing here takes a lock. Each tombstone is one conditional
// update that re-states the facts the selection relied on (still ACTIVE, same
// `lastLoginAt`), so a user who signs in or is reactivated between the select
// and the write is left alone. Two overlapping runs tombstone a user once.

// A type alias, not an interface, so it is assignable to a job's result record.
export type RetentionReport = {
  dryRun: boolean;
  tombstoned: { deactivated: number; inactive: number; unverified: number };
  notices: { sent: number; capped: number; failed: number };
  purged: { sessions: number; verifications: number; unlockTokens: number };
  anonymizedAuditRows: number;
  /** Admins and the Primary Admin past a threshold: for manual review. */
  exempt: { userId: string; rule: "deactivated" | "inactive" }[];
  /** Rows over a batch cap, left for the next run. */
  deferred: { tombstones: number; notices: number };
  errors: number;
};

export interface RetentionDeps {
  db: PrismaClient;
  mailer: Pick<Mailer, "sendEmail">;
  /** The sign-in page the notice links to. */
  signInUrl: string;
  now: Date;
  dryRun: boolean;
  log?: Pick<Logger, "warn" | "error">;
}

const SYSTEM = { actorType: "SYSTEM" } as const;

const IS_ADMIN: Prisma.UserWhereInput = {
  OR: [{ isAdmin: true }, { isPrimaryAdmin: true }],
};
const NOT_ADMIN: Prisma.UserWhereInput = {
  isAdmin: false,
  isPrimaryAdmin: false,
};

// The reference is `lastLoginAt`, or `createdAt` for a user who never signed in.
function referenceAtOrBefore(at: Date): Prisma.UserWhereInput {
  return {
    OR: [
      { lastLoginAt: { lte: at } },
      { lastLoginAt: null, createdAt: { lte: at } },
    ],
  };
}

export async function runRetention({
  db,
  mailer,
  signInUrl,
  now,
  dryRun,
  log = logger,
}: RetentionDeps): Promise<RetentionReport> {
  const c = cutoffs(now);
  const report: RetentionReport = {
    dryRun,
    tombstoned: { deactivated: 0, inactive: 0, unverified: 0 },
    notices: { sent: 0, capped: 0, failed: 0 },
    purged: { sessions: 0, verifications: 0, unlockTokens: 0 },
    anonymizedAuditRows: 0,
    exempt: [],
    deferred: { tombstones: 0, notices: 0 },
    errors: 0,
  };

  const fail = (step: string, err: unknown) => {
    report.errors += 1;
    log.error("retention_step_failed", {
      step,
      errorName: err instanceof Error ? err.name : "UnknownError",
    });
  };

  const step = async (name: string, run: () => Promise<void>) => {
    try {
      await run();
    } catch (err) {
      fail(name, err);
    }
  };

  /**
   * Tombstones one user at a time, so one failure is counted and the rest still
   * go. `guard` re-states what the selection relied on.
   */
  async function tombstoneAll(
    name: string,
    reason: TombstoneInput["reason"],
    users: { id: string; guard: Prisma.UserWhereInput }[],
  ): Promise<number> {
    if (dryRun) return users.length;
    let done = 0;
    for (const { id, guard } of users) {
      try {
        const { tombstoned } = await tombstoneUser(db, {
          userId: id,
          reason,
          actor: SYSTEM,
          guard,
        });
        if (tombstoned) done += 1;
      } catch (err) {
        fail(name, err);
      }
    }
    return done;
  }

  await step("deactivated", async () => {
    const due: Prisma.UserWhereInput = {
      status: "DEACTIVATED",
      deactivatedAt: { lte: c.deactivatedBefore },
    };
    const where = { ...due, ...NOT_ADMIN };
    const total = await db.user.count({ where });
    const users = await db.user.findMany({
      where,
      select: { id: true },
      orderBy: { deactivatedAt: "asc" },
      take: TOMBSTONE_BATCH,
    });
    report.deferred.tombstones += Math.max(0, total - users.length);
    report.tombstoned.deactivated = await tombstoneAll(
      "deactivated",
      "deactivated_30d",
      users.map(({ id }) => ({ id, guard: { ...due, isAdmin: false } })),
    );

    const exempt = await db.user.findMany({
      where: { ...due, ...IS_ADMIN },
      select: { id: true },
    });
    for (const { id } of exempt) {
      report.exempt.push({ userId: id, rule: "deactivated" });
    }
  });

  // Before the notices, so a user is never noticed and tombstoned in one run.
  await step("inactive-tombstone", async () => {
    const candidates = await db.user.findMany({
      where: {
        status: "ACTIVE",
        ...NOT_ADMIN,
        inactivityNoticeSentAt: { not: null },
        ...referenceAtOrBefore(c.inactiveBefore),
      },
      select: {
        id: true,
        lastLoginAt: true,
        createdAt: true,
        inactivityNoticeSentAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    // The notice must have given its full lead time. A sign-in after the notice
    // supersedes it, and then the user is no longer a candidate by age either.
    const due = candidates.filter((user) => {
      const reference = inactivityReference(user);
      return (
        noticeIsCurrent(reference, user.inactivityNoticeSentAt) &&
        inactivityDeadline(reference, user.inactivityNoticeSentAt) <= now
      );
    });
    const batch = due.slice(0, TOMBSTONE_BATCH);
    report.deferred.tombstones += due.length - batch.length;
    report.tombstoned.inactive = await tombstoneAll(
      "inactive-tombstone",
      "inactive_12mo",
      batch.map(({ id, lastLoginAt }) => ({
        id,
        // A sign-in since the select changes `lastLoginAt` and misses this.
        guard: { status: "ACTIVE", isAdmin: false, lastLoginAt },
      })),
    );

    // Holding positions does not exempt a user; being an admin does.
    const exempt = await db.user.findMany({
      where: {
        status: "ACTIVE",
        ...IS_ADMIN,
        ...referenceAtOrBefore(c.inactiveBefore),
      },
      select: { id: true },
    });
    for (const { id } of exempt) {
      report.exempt.push({ userId: id, rule: "inactive" });
    }
  });

  await step("inactive-notice", async () => {
    const candidates = await db.user.findMany({
      where: {
        status: "ACTIVE",
        ...NOT_ADMIN,
        ...referenceAtOrBefore(c.noticeBefore),
      },
      select: {
        id: true,
        email: true,
        name: true,
        preferredName: true,
        lastLoginAt: true,
        createdAt: true,
        inactivityNoticeSentAt: true,
      },
      orderBy: { createdAt: "asc" },
    });
    const due = candidates.filter(
      (user) =>
        !noticeIsCurrent(
          inactivityReference(user),
          user.inactivityNoticeSentAt,
        ),
    );
    const batch = due.slice(0, NOTICE_BATCH);
    report.deferred.notices += due.length - batch.length;
    if (dryRun) {
      report.notices.sent = batch.length;
      return;
    }

    for (const user of batch) {
      const reference = inactivityReference(user);
      try {
        const result = await mailer.sendEmail({
          to: user.email,
          template: "inactivity-notice",
          data: {
            name: displayName(user),
            lastLoginAt: reference,
            // Counted from now, so a notice that goes out late still gives
            // the full lead time.
            deactivateAfter: inactivityDeadline(reference, now),
            signInUrl,
          },
        });
        if (result.status === "sent") {
          // Recorded only on `sent`: `capped` and `failed` retry tomorrow.
          await db.user.updateMany({
            where: { id: user.id, status: "ACTIVE" },
            data: { inactivityNoticeSentAt: now },
          });
          report.notices.sent += 1;
        } else if (result.status === "capped") {
          report.notices.capped += 1;
        } else {
          report.notices.failed += 1;
        }
      } catch (err) {
        // A programmer error (a template rejected the data) or a database
        // failure. It is this user only.
        report.notices.failed += 1;
        fail("inactive-notice", err);
      }
    }
  });

  await step("unverified", async () => {
    // Only a self sign-up whose audit row says so. An invited or imported user,
    // or a sign-up whose audit write was lost, is never purged.
    const rows = await db.$queryRaw<{ id: string }[]>`
      SELECT u."id" FROM "User" u
      WHERE u."status" = 'ACTIVE'
        AND NOT u."emailVerified"
        AND u."lastLoginAt" IS NULL
        AND NOT u."isAdmin" AND NOT u."isPrimaryAdmin"
        AND u."createdAt" <= ${c.unverifiedBefore}
        AND EXISTS (
          SELECT 1 FROM "AuditEvent" a
          WHERE a."type" = 'USER_CREATED'
            AND a."targetId" = u."id"
            AND a."metadata"->>'source' = 'self_signup')
      ORDER BY u."createdAt"`;
    const batch = rows.slice(0, TOMBSTONE_BATCH);
    report.deferred.tombstones += rows.length - batch.length;
    // A tombstone, not a hard delete: users are never hard-deleted
    // (ENGINEERING §2), and the tombstone frees the address.
    report.tombstoned.unverified = await tombstoneAll(
      "unverified",
      "unverified_7d",
      batch.map(({ id }) => ({
        id,
        guard: { status: "ACTIVE", emailVerified: false, lastLoginAt: null },
      })),
    );
  });

  // Prisma's deleteMany fires no Better Auth hook, so no LOGOUT row is written:
  // expiry is not a sign-out.
  await step("purge", async () => {
    const sessions: Prisma.SessionWhereInput = {
      OR: [
        { expiresAt: { lt: now } },
        { absoluteExpiresAt: { lte: now } },
        // The absolute cap, whatever a refresh did to `expiresAt` (AUTH-T27).
        { createdAt: { lte: c.sessionCreatedBefore } },
      ],
    };
    const verifications = { expiresAt: { lt: now } };
    const unlockTokens = { expiresAt: { lt: now } };
    if (dryRun) {
      report.purged = {
        sessions: await db.session.count({ where: sessions }),
        verifications: await db.verification.count({ where: verifications }),
        unlockTokens: await db.unlockToken.count({ where: unlockTokens }),
      };
      return;
    }
    report.purged.sessions = (
      await db.session.deleteMany({ where: sessions })
    ).count;
    report.purged.verifications = (
      await db.verification.deleteMany({ where: verifications })
    ).count;
    report.purged.unlockTokens = (
      await db.unlockToken.deleteMany({ where: unlockTokens })
    ).count;
  });

  // Sessions older than 90 days are already gone, so their IP and user agent
  // need no update of their own.
  await step("pii", async () => {
    const where: Prisma.AuditEventWhereInput = {
      createdAt: { lte: c.piiBefore },
      OR: [{ ip: { not: null } }, { userAgent: { not: null } }],
    };
    if (dryRun) {
      report.anonymizedAuditRows = await db.auditEvent.count({ where });
      return;
    }
    // Only the network fields: the catalog keeps PII out of `metadata`, and the
    // row's type, actor and target stay.
    const result = await withAuditAnonymization(db, (tx) =>
      tx.auditEvent.updateMany({ where, data: { ip: null, userAgent: null } }),
    );
    report.anonymizedAuditRows = result.count;
  });

  for (const rule of ["deactivated", "inactive"] as const) {
    const userIds = report.exempt
      .filter((entry) => entry.rule === rule)
      .map((entry) => entry.userId);
    if (userIds.length > 0) log.warn("retention_exempt", { rule, userIds });
  }

  return report;
}
