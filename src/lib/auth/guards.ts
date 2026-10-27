import "server-only";
import { notFound, redirect } from "next/navigation";
import { getCurrentUser, type CurrentUser } from "@/lib/auth/current-user";
import { MFA_ENROLLMENT_PATH } from "@/lib/auth/mfa-policy";
import { can } from "@/lib/authz";

/** Whether the user may see admin pages. The only place that is decided. */
export function canAccessAdmin(user: CurrentUser): boolean {
  return can(user, "accessAdmin").allowed;
}

/**
 * Signed-out users go to `/login`, then back to `path`. `path` must be a
 * literal starting with `/`; the login page validates the redirect again.
 */
export async function requireUser(path: string): Promise<CurrentUser> {
  const user = await getCurrentUser();
  if (!user) redirect(`/login?redirect=${encodeURIComponent(path)}`);
  return user;
}

/**
 * Non-admins get the same 404 as an unknown URL; an admin without MFA goes to
 * enrollment. Signed-out users are sent to login rather than given a 404,
 * because they might be admins: the existence of `/admin` is not secret.
 *
 * Call this from every admin page and server action, not only the layout:
 * layouts are skipped on soft navigation between pages.
 */
export async function requireAdmin(path: string): Promise<CurrentUser> {
  const user = await requireUser(path);
  if (!canAccessAdmin(user)) notFound();
  if (!user.twoFactorEnabled) {
    redirect(`${MFA_ENROLLMENT_PATH}?reason=mfa-required`);
  }
  return user;
}
