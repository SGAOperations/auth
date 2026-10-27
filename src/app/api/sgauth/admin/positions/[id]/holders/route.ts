import type { NextRequest } from "next/server";
import { apiError, apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import { audit, withAuditTransaction } from "@/lib/audit";
import { can } from "@/lib/authz";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import {
  AssignmentError,
  assignPositionToUsers,
  assignPositionToUsersInputSchema,
  assignmentErrorResponse,
  assignmentIdSchema,
} from "@/lib/position-assignments";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/positions/[id]/holders";

type Ctx = { params: Promise<{ id: string }> };

async function post(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const positionId = assignmentIdSchema.safeParse((await ctx.params).id);
  if (!positionId.success) {
    return apiError(400, "INVALID_INPUT", "This position id isn't valid.");
  }
  const body = await readJson(request, assignPositionToUsersInputSchema);
  if ("response" in body) return body.response;

  try {
    const result = await withAuditTransaction(prisma, async (tx) => {
      const changes = await assignPositionToUsers(tx, {
        actorId: actor.id,
        positionId: positionId.data,
        userIds: body.data.userIds,
        authorize: (target) => can(actor, "assignPosition", target),
      });
      for (const userId of changes.assigned) {
        await audit({
          type: "POSITION_ASSIGNED",
          actorType: "USER",
          actorUserId: actor.id,
          targetType: "USER",
          targetId: userId,
          metadata: { positionId: positionId.data },
        });
      }
      return changes;
    });
    return apiJson({ positionId: positionId.data, ...result });
  } catch (err) {
    if (err instanceof AssignmentError) return assignmentErrorResponse(err);
    throw err;
  }
}

// The wrapper's handler takes only the request, so the context is closed over.
export const POST = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => post(req, ctx), logger)(request);
