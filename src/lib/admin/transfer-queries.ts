import "server-only";
import { prisma } from "@/lib/prisma";
import type {
  AcceptView,
  InFlightTransfer,
  RecentCompletion,
  RecipientCandidate,
} from "@/lib/admin/transfer-view";

// Reads for the transfer screens. Every `select` is explicit and none reaches
// `cancelTokenHash`: a stored token hash is never shown, even to an admin.

const RECENT_COMPLETION_MS = 7 * 24 * 60 * 60 * 1000;

const partySelect = { name: true, preferredName: true } as const;

/** Every admin who has not been deleted, so a deactivated one can show why it can't be picked. */
export async function listRecipientCandidates(): Promise<RecipientCandidate[]> {
  return prisma.user.findMany({
    where: { isAdmin: true, status: { not: "DELETED" } },
    select: {
      id: true,
      name: true,
      preferredName: true,
      email: true,
      status: true,
      twoFactorEnabled: true,
    },
    orderBy: [{ name: "asc" }, { id: "asc" }],
  });
}

/** The one transfer waiting for acceptance or cooling, if any. */
export async function getInFlightTransfer(): Promise<InFlightTransfer | null> {
  const transfer = await prisma.primaryAdminTransfer.findFirst({
    where: { status: { in: ["PENDING_ACCEPTANCE", "COOLING"] } },
    select: {
      id: true,
      status: true,
      fromUserId: true,
      toUserId: true,
      acceptanceExpiresAt: true,
      executesAt: true,
      fromUser: { select: partySelect },
      toUser: { select: partySelect },
    },
  });
  if (!transfer) return null;
  // The where clause admits only these two; the generated type cannot say so.
  const status =
    transfer.status === "COOLING" ? "COOLING" : "PENDING_ACCEPTANCE";
  return { ...transfer, status };
}

/**
 * The newest transfer addressed to `viewerId`. Anyone else, and anyone with no
 * transfer, gets `null`, so the page answers both with the same 404.
 */
export async function getAcceptView(
  viewerId: string,
): Promise<AcceptView | null> {
  return prisma.primaryAdminTransfer.findFirst({
    where: { toUserId: viewerId },
    orderBy: { createdAt: "desc" },
    select: {
      id: true,
      status: true,
      acceptanceExpiresAt: true,
      executesAt: true,
      fromUser: { select: partySelect },
    },
  });
}

/** The latest completed transfer, while it is less than a week old. */
export async function getRecentCompletion(
  now: Date = new Date(),
): Promise<RecentCompletion | null> {
  const completion = await prisma.primaryAdminTransfer.findFirst({
    where: {
      status: "COMPLETED",
      completedAt: { gte: new Date(now.getTime() - RECENT_COMPLETION_MS) },
    },
    orderBy: { completedAt: "desc" },
    select: {
      id: true,
      completedAt: true,
      fromUser: { select: partySelect },
      toUser: { select: partySelect },
    },
  });
  if (!completion?.completedAt) return null;
  return { ...completion, completedAt: completion.completedAt };
}
