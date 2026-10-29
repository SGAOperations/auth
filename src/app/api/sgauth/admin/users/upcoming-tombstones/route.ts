import { z } from "zod";
import { apiJson, invalidInputResponse, requireAdmin } from "@/lib/admin-api";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { prisma } from "@/lib/prisma";
import { listUpcomingTombstones } from "@/lib/retention/upcoming";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const ROUTE = "/api/sgauth/admin/users/upcoming-tombstones";

const query = z.object({
  withinDays: z.coerce.number().int().min(1).max(90).default(30),
});

// Read only: no mutation limit, no Origin check and no audit row. It shows the
// same names and addresses as the user list. The users list page (#60) renders
// it.
async function upcoming(request: Request) {
  const guard = await requireAdmin({ mutation: false, action: "accessAdmin" });
  if ("response" in guard) return guard.response;

  const parsed = query.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!parsed.success) return invalidInputResponse(parsed.error);

  const users = await listUpcomingTombstones(prisma, {
    now: new Date(),
    withinDays: parsed.data.withinDays,
  });
  return apiJson({ users });
}

export const GET = withRequestLogging(ROUTE, upcoming, logger);
