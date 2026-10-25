import type { NextRequest } from "next/server";
import { z } from "zod";
import {
  apiJson,
  positionErrorResponse,
  positionNotFound,
  readJson,
  requireAdmin,
} from "@/lib/admin-api";
import { audit, withAuditTransaction } from "@/lib/audit";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import {
  PositionError,
  deletePosition,
  getPositionSummary,
  updatePosition,
} from "@/lib/positions";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/positions/[id]";

type Ctx = { params: Promise<{ id: string }> };

const deleteBodySchema = z.strictObject({ confirmKey: z.string() });

// A malformed id and an unknown id look the same.
async function positionId(ctx: Ctx): Promise<string | null> {
  const parsed = z.uuid().safeParse((await ctx.params).id);
  return parsed.success ? parsed.data : null;
}

/** The delete preflight: deleted positions are returned too. */
async function get(_request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: false });
  if ("response" in guard) return guard.response;

  const id = await positionId(ctx);
  const position = id ? await getPositionSummary(id) : null;
  if (!position) return positionNotFound();
  return apiJson({ position });
}

async function patch(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const id = await positionId(ctx);
  if (!id) return positionNotFound();
  const body = await readJson(request, z.unknown());
  if ("response" in body) return body.response;

  try {
    const position = await withAuditTransaction(prisma, async (tx) => {
      const result = await updatePosition(id, body.data, actor.id, {
        db: tx,
      });
      if (result.changed) {
        await audit({
          type: "POSITION_UPDATED",
          actorType: "USER",
          actorUserId: actor.id,
          targetType: "POSITION",
          targetId: id,
          metadata: { before: result.before, after: result.after },
        });
      }
      return getPositionSummary(id, { db: tx });
    });
    return apiJson({ position });
  } catch (err) {
    if (err instanceof PositionError) return positionErrorResponse(err);
    throw err;
  }
}

async function remove(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const id = await positionId(ctx);
  if (!id) return positionNotFound();
  const body = await readJson(request, deleteBodySchema);
  if ("response" in body) return body.response;

  try {
    const { position, holderCount } = await withAuditTransaction(
      prisma,
      async (tx) => {
        const result = await deletePosition(
          id,
          body.data.confirmKey,
          actor.id,
          {
            db: tx,
          },
        );
        await audit({
          type: "POSITION_DELETED",
          actorType: "USER",
          actorUserId: actor.id,
          targetType: "POSITION",
          targetId: id,
          metadata: {
            before: result.before,
            after: { deletedAt: result.deletedAt.toISOString() },
            holderIds: result.holderIds,
          },
        });
        return {
          position: await getPositionSummary(id, { db: tx }),
          holderCount: result.holderIds.length,
        };
      },
    );
    return apiJson({ position, holderCount });
  } catch (err) {
    if (err instanceof PositionError) return positionErrorResponse(err);
    throw err;
  }
}

// The wrapper's handler takes only the request, so the context is closed over.
export const GET = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => get(req, ctx), logger)(request);
export const PATCH = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => patch(req, ctx), logger)(request);
export const DELETE = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => remove(req, ctx), logger)(request);
