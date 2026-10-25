import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/config";
import { createAdminGuard } from "@/lib/auth/admin-guard";
import { prisma } from "@/lib/prisma";

export { auth };

export type Session = typeof auth.$Infer.Session;

export async function getSession() {
  return auth.api.getSession({ headers: await headers() });
}

const adminGuard = createAdminGuard({
  getSession: (requestHeaders) =>
    auth.api.getSession({ headers: requestHeaders }),
  prisma,
});

/** For route handlers: pass the request's headers. */
export const { requireAdmin } = adminGuard;

/** For server components: reads the request's headers itself. */
export async function requireAdminPage() {
  return adminGuard.requireAdminPage(await headers());
}
