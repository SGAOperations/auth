import "server-only";
import { headers } from "next/headers";
import { auth } from "@/lib/auth/config";
import { createAdminGuard } from "@/lib/auth/admin-guard";
import { createFreshAuthGuard } from "@/lib/auth/fresh-auth";
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

const freshAuthGuard = createFreshAuthGuard({
  getSession: (requestHeaders) =>
    auth.api.getSession({ headers: requestHeaders }),
  prisma,
});

/**
 * For sensitive route handlers (docs/REAUTH.md). Call it after the Origin
 * check and before `can()`. Reads the request's headers when none are passed.
 */
export async function requireFreshAuth(requestHeaders?: Headers) {
  return freshAuthGuard(requestHeaders ?? (await headers()));
}

/** For server components: reads the request's headers itself. */
export async function requireAdminPage() {
  return adminGuard.requireAdminPage(await headers());
}
