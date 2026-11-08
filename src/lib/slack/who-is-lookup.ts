import "server-only";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";
import { canUseWhoIs } from "@/lib/authz";
import { displayName } from "@/lib/user-display";
import { lookupSlackIdentities } from "./identity";
import {
  sortWhoIsPositions,
  type WhoIsLookupInput,
  type WhoIsResult,
} from "./who-is";

type Db = PrismaClient | Prisma.TransactionClient;

/**
 * The reads behind `/who-is` (#349). Read only: writes no rows and no audit
 * event, the same as `loadOrgChart`. Lookups are not audited (decision 2).
 *
 * A target who is not linked, or is deactivated or deleted, is `target_unlinked`
 * in every case, so a member learns nothing about someone else's account
 * status. The caller is the signed Slack user, never an input the client picks.
 */
export async function loadWhoIs(
  db: Db,
  input: WhoIsLookupInput,
): Promise<WhoIsResult> {
  const { slackTeamId, callerSlackUserId, targetSlackUserId } = input;
  const links = await lookupSlackIdentities(db, {
    slackTeamId,
    slackUserIds: [...new Set([callerSlackUserId, targetSlackUserId])],
    userIds: [],
  });

  const callerLink = links.find((l) => l.slackUserId === callerSlackUserId);
  if (!callerLink) return { kind: "caller_unlinked" };
  const caller = await db.user.findUnique({
    where: { id: callerLink.userId },
    select: { id: true, isAdmin: true, isPrimaryAdmin: true, status: true },
  });
  if (!caller || !canUseWhoIs(caller).allowed) {
    return { kind: "caller_unlinked" };
  }

  const targetLink = links.find((l) => l.slackUserId === targetSlackUserId);
  if (!targetLink) return { kind: "target_unlinked" };
  const target = await db.user.findUnique({
    where: { id: targetLink.userId },
    select: {
      name: true,
      preferredName: true,
      status: true,
      positions: {
        where: { position: { deletedAt: null } },
        select: {
          position: {
            select: {
              name: true,
              category: true,
              isLeadership: true,
              manager: {
                select: { name: true, category: true, deletedAt: true },
              },
            },
          },
        },
      },
    },
  });
  // The row can change between the two reads.
  if (!target || target.status !== "ACTIVE") return { kind: "target_unlinked" };

  return {
    kind: "found",
    name: displayName(target),
    positions: sortWhoIsPositions(
      target.positions.map(({ position }) => ({
        name: position.name,
        category: position.category,
        isLeadership: position.isLeadership,
        // Defensive: deletePosition already clears the reports' manager.
        manager:
          position.manager && position.manager.deletedAt === null
            ? {
                name: position.manager.name,
                category: position.manager.category,
              }
            : null,
      })),
    ),
  };
}
