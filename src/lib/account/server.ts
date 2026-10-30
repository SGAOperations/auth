import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import type { ProfileInput } from "@/lib/account/profile";
import {
  sortPositionsForDisplay,
  visibleTools,
  type ToolProduct,
} from "@/lib/account/tools";
import { prisma } from "@/lib/prisma";

export interface AccountOverview {
  profile: { email: string; name: string; preferredName: string | null };
  positions: { key: string; name: string }[];
  /** True when the user holds at least one active leadership position. */
  isLeadership: boolean;
  tools: ToolProduct[];
}

interface Deps {
  db?: Pick<PrismaClient, "user" | "product">;
}

/**
 * What the account page shows for `userId`, or null when the user is missing or
 * not ACTIVE. Positions are the active ones only; a soft-deleted position
 * grants no visibility, and a soft-deleted leadership position confers no
 * leadership. Products are read per request, so an admin's edit shows
 * immediately. `iconUrl` is not selected: the CSP would block it.
 */
export async function loadAccountOverview(
  userId: string,
  { db = prisma }: Deps = {},
): Promise<AccountOverview | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      preferredName: true,
      status: true,
      positions: {
        where: { position: { deletedAt: null } },
        select: {
          position: {
            select: { key: true, name: true, isLeadership: true },
          },
        },
      },
    },
  });
  if (!user || user.status !== "ACTIVE") return null;

  const products = await db.product.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { name: "asc" }],
    select: {
      id: true,
      slug: true,
      name: true,
      description: true,
      baseUrl: true,
      isActive: true,
      visibility: true,
      visibleToPositionKeys: true,
    },
  });

  const held = user.positions.map((entry) => entry.position);
  const isLeadership = held.some((position) => position.isLeadership);
  const positions = held.map(({ key, name }) => ({ key, name }));
  return {
    profile: {
      email: user.email,
      name: user.name,
      preferredName: user.preferredName,
    },
    positions: sortPositionsForDisplay(positions),
    isLeadership,
    tools: visibleTools(products, {
      positionKeys: new Set(positions.map((p) => p.key)),
      isLeadership,
    }),
  };
}

/**
 * Writes the caller's own name and preferred name and nothing else. It does not
 * authorize: the action does. `updated` is false when the user is not ACTIVE.
 */
export async function updateOwnProfile(
  userId: string,
  input: ProfileInput,
  { db = prisma }: { db?: Pick<PrismaClient, "user"> } = {},
): Promise<{ updated: boolean }> {
  const { count } = await db.user.updateMany({
    where: { id: userId, status: "ACTIVE" },
    data: { name: input.name, preferredName: input.preferredName },
  });
  return { updated: count === 1 };
}
