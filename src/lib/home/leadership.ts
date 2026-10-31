import "server-only";
import { redirect } from "next/navigation";
import { loadAccountOverview } from "@/lib/account/server";
import { requireUser } from "@/lib/auth/guards";

/**
 * The one place the leadership pages decide access. Signed-out users go to
 * login and back to `path`; the caller shows `LeadershipOnly` when
 * `isLeadership` is false and renders no leadership content.
 */
export async function loadLeadershipViewer(
  path: string,
): Promise<{ isLeadership: boolean }> {
  const user = await requireUser(path);
  const overview = await loadAccountOverview(user.id);
  if (!overview) redirect("/login");
  return { isLeadership: overview.isLeadership };
}
