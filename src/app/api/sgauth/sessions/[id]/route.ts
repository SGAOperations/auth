import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { ownSessions } from "@/lib/sessions/server";

export const runtime = "nodejs";

export async function DELETE(
  request: Request,
  ctx: { params: Promise<{ id: string }> },
) {
  const { id } = await ctx.params;
  return withRequestLogging(
    "/api/sgauth/sessions/[id]",
    (req) => ownSessions.revoke(req, id),
    logger,
  )(request);
}
