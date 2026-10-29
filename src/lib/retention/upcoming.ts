import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import {
  DEACTIVATED_TOMBSTONE_AFTER_DAYS,
  deactivatedTombstoneAt,
  INACTIVITY_TOMBSTONE_AFTER_DAYS,
  inactivityDeadline,
  inactivityNoticeDue,
  inactivityReference,
  noticeIsCurrent,
} from "@/lib/retention/policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const LIMIT = 200;

export interface UpcomingTombstone {
  userId: string;
  name: string;
  email: string;
  status: "ACTIVE" | "DEACTIVATED";
  rule: "deactivated" | "inactive";
  tombstoneAt: Date;
  /** The notice on record, when it is still current. */
  noticeSentAt: Date | null;
  /** Admins and the Primary Admin are never auto-tombstoned: review by hand. */
  exempt: boolean;
}

const select = {
  id: true,
  name: true,
  email: true,
  status: true,
  isAdmin: true,
  isPrimaryAdmin: true,
  deactivatedAt: true,
  lastLoginAt: true,
  createdAt: true,
  inactivityNoticeSentAt: true,
} satisfies Prisma.UserSelect;

/**
 * Users the retention job will tombstone within `withinDays`, soonest first,
 * for the admin users list (#60). A user already past the date is included. It
 * is a read of the same rules as the job (policy.ts) and writes nothing.
 * Unverified sign-ups are left out: they are cleaned up within a week and an
 * admin has nothing to review.
 */
export async function listUpcomingTombstones(
  db: Pick<PrismaClient, "user">,
  { now, withinDays }: { now: Date; withinDays: number },
): Promise<UpcomingTombstone[]> {
  const horizon = new Date(now.getTime() + withinDays * DAY_MS);

  // Anything that is not past this reference cannot reach its deadline in time.
  const referenceBy = new Date(
    horizon.getTime() - INACTIVITY_TOMBSTONE_AFTER_DAYS * DAY_MS,
  );
  const deactivatedBy = new Date(
    horizon.getTime() - DEACTIVATED_TOMBSTONE_AFTER_DAYS * DAY_MS,
  );

  const [deactivated, active] = await Promise.all([
    db.user.findMany({
      where: { status: "DEACTIVATED", deactivatedAt: { lte: deactivatedBy } },
      select,
    }),
    db.user.findMany({
      where: {
        status: "ACTIVE",
        OR: [
          { lastLoginAt: { lte: referenceBy } },
          { lastLoginAt: null, createdAt: { lte: referenceBy } },
        ],
      },
      select,
    }),
  ]);

  const rows: UpcomingTombstone[] = [];
  const exempt = (user: { isAdmin: boolean; isPrimaryAdmin: boolean }) =>
    user.isAdmin || user.isPrimaryAdmin;

  for (const user of deactivated) {
    if (!user.deactivatedAt) continue;
    rows.push({
      userId: user.id,
      name: user.name,
      email: user.email,
      status: "DEACTIVATED",
      rule: "deactivated",
      tombstoneAt: deactivatedTombstoneAt(user.deactivatedAt),
      noticeSentAt: null,
      exempt: exempt(user),
    });
  }

  for (const user of active) {
    const reference = inactivityReference(user);
    const sentAt = user.inactivityNoticeSentAt;
    const noticeSentAt = noticeIsCurrent(reference, sentAt) ? sentAt : null;
    // With no notice yet, the job sends it on its next run, or when the user
    // reaches 11 months, whichever is later; the 30 days of lead run from then.
    const noticeAt =
      noticeSentAt ??
      new Date(
        Math.max(now.getTime(), inactivityNoticeDue(reference).getTime()),
      );
    const tombstoneAt = inactivityDeadline(reference, noticeAt);
    if (tombstoneAt > horizon) continue;
    rows.push({
      userId: user.id,
      name: user.name,
      email: user.email,
      status: "ACTIVE",
      rule: "inactive",
      tombstoneAt,
      noticeSentAt,
      exempt: exempt(user),
    });
  }

  return rows
    .sort((a, b) => a.tombstoneAt.getTime() - b.tombstoneAt.getTime())
    .slice(0, LIMIT);
}
