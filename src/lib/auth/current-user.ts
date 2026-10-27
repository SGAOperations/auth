import "server-only";
import { cache } from "react";
import { APIError } from "better-auth/api";
import { getSession } from "@/lib/auth/server";
import { prisma } from "@/lib/prisma";

/**
 * The signed-in, active user, or null. Runs once per request. The session user
 * carries `status` but not the admin flags, so the row is read fresh: a revoked
 * admin loses access on the next request.
 */
export const getCurrentUser = cache(async () => {
  let session;
  try {
    session = await getSession();
  } catch (error) {
    // The get-session hook throws for a deactivated or otherwise rejected user.
    if (error instanceof APIError) return null;
    throw error;
  }
  if (!session) return null;

  const user = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      email: true,
      name: true,
      preferredName: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      twoFactorEnabled: true,
      status: true,
    },
  });
  if (!user || user.status !== "ACTIVE") return null;
  return user;
});

export type CurrentUser = NonNullable<
  Awaited<ReturnType<typeof getCurrentUser>>
>;
