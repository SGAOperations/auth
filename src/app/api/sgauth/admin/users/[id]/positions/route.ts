import type { NextRequest } from "next/server";
import { apiError, apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import { audit, withAuditTransaction } from "@/lib/audit";
import { can, type AuthzDecision, type AuthzSubject } from "@/lib/authz";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import {
  AssignmentError,
  assignmentErrorResponse,
  assignmentIdSchema,
  updateUserPositions,
  updateUserPositionsInputSchema,
} from "@/lib/position-assignments";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/users/[id]/positions";

type Ctx = { params: Promise<{ id: string }> };

async function patch(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const userId = assignmentIdSchema.safeParse((await ctx.params).id);
  if (!userId.success) {
    return apiError(400, "INVALID_INPUT", "This user id isn't valid.");
  }
  const body = await readJson(request, updateUserPositionsInputSchema);
  if ("response" in body) return body.response;
  const { assign, unassign } = body.data;

  const authorize = (target: AuthzSubject): AuthzDecision => {
    if (unassign.length > 0) {
      const decision = can(actor, "unassignPosition", target);
      if (!decision.allowed) return decision;
    }
    if (assign.length > 0) {
      const decision = can(actor, "assignPosition", target);
      if (!decision.allowed) return decision;
    }
    return { allowed: true };
  };

  try {
    const result = await withAuditTransaction(prisma, async (tx) => {
      const changes = await updateUserPositions(tx, {
        actorId: actor.id,
        userId: userId.data,
        assign,
        unassign,
        authorize,
      });
      for (const positionId of changes.unassigned) {
        await audit({
          type: "POSITION_UNASSIGNED",
          actorType: "USER",
          actorUserId: actor.id,
          targetType: "USER",
          targetId: userId.data,
          metadata: { positionId },
        });
      }
      for (const positionId of changes.assigned) {
        await audit({
          type: "POSITION_ASSIGNED",
          actorType: "USER",
          actorUserId: actor.id,
          targetType: "USER",
          targetId: userId.data,
          metadata: { positionId },
        });
      }
      return changes;
    });
    return apiJson({ userId: userId.data, ...result });
  } catch (err) {
    if (err instanceof AssignmentError) return assignmentErrorResponse(err);
    throw err;
  }
}

// The wrapper's handler takes only the request, so the context is closed over.
export const PATCH = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => patch(req, ctx), logger)(request);
