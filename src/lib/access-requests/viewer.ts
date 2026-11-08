import "server-only";
import { notFound } from "next/navigation";
import { cache } from "react";
import type { Prisma } from "@/generated/prisma/client";
import { type CurrentUser } from "@/lib/auth/current-user";
import { requireUser } from "@/lib/auth/guards";
import { canViewAccessRequests } from "@/lib/authz";
import { prisma } from "@/lib/prisma";

/** The keys of the user's non-deleted positions. */
export async function loadHeldPositionKeys(
  userId: string,
  { db = prisma }: { db?: Pick<Prisma.TransactionClient, "userPosition"> } = {},
): Promise<string[]> {
  const rows = await db.userPosition.findMany({
    where: { userId, position: { deletedAt: null } },
    select: { position: { select: { key: true } } },
  });
  return rows.map((row) => row.position.key);
}

/**
 * Whether the user may see access requests. Cached per request, because the
 * layout (for the nav link) and the page both ask.
 */
export const canShowAccessRequests = cache(
  async (user: CurrentUser): Promise<boolean> =>
    canViewAccessRequests(user, await loadHeldPositionKeys(user.id)).allowed,
);

/**
 * Signed-out users go to login; everyone else who is not a viewer gets the same
 * 404 as an unknown URL. This is the one place the access requests page decides
 * access. Call it from every render of the page, not only the layout: layouts
 * are skipped on soft navigation (the same note as `requireAdmin`).
 */
export async function requireAccessRequestViewer(
  path: string,
): Promise<CurrentUser> {
  const user = await requireUser(path);
  if (!(await canShowAccessRequests(user))) notFound();
  return user;
}
