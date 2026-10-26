import { z } from "zod";
import {
  apiError,
  apiJson,
  positionErrorResponse,
  readJson,
  requireAdmin,
} from "@/lib/admin-api";
import { audit, withAuditTransaction } from "@/lib/audit";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import {
  PositionError,
  createPosition,
  getPositionSummary,
  listPositions,
  positionSnapshot,
} from "@/lib/positions";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/positions";

const listQuerySchema = z.enum(["true", "false"]).optional();

async function list(request: Request) {
  const guard = await requireAdmin({ mutation: false });
  if ("response" in guard) return guard.response;

  const includeDeleted = listQuerySchema.safeParse(
    new URL(request.url).searchParams.get("includeDeleted") ?? undefined,
  );
  if (!includeDeleted.success) {
    return apiError(
      400,
      "INVALID_INPUT",
      "includeDeleted must be true or false.",
    );
  }

  const positions = await listPositions({
    includeDeleted: includeDeleted.data === "true",
  });
  return apiJson({ positions });
}

async function create(request: Request) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const body = await readJson(request, z.unknown());
  if ("response" in body) return body.response;

  try {
    const position = await withAuditTransaction(prisma, async (tx) => {
      const created = await createPosition(body.data, actor.id, { db: tx });
      await audit({
        type: "POSITION_CREATED",
        actorType: "USER",
        actorUserId: actor.id,
        targetType: "POSITION",
        targetId: created.id,
        metadata: { after: positionSnapshot(created) },
      });
      return getPositionSummary(created.id, { db: tx });
    });
    return apiJson({ position }, { status: 201 });
  } catch (err) {
    if (err instanceof PositionError) return positionErrorResponse(err);
    throw err;
  }
}

export const GET = withRequestLogging(ROUTE, list, logger);
export const POST = withRequestLogging(ROUTE, create, logger);
