import type { NextRequest } from "next/server";
import { apiError, apiJson, requireAdmin } from "@/lib/admin-api";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import {
  HISTORY_ERRORS,
  getPositionHistory,
  historyIdSchema,
  historyQuerySchema,
} from "@/lib/position-history";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/positions/[id]/history";

type Ctx = { params: Promise<{ id: string }> };

const fail = (code: keyof typeof HISTORY_ERRORS) =>
  apiError(HISTORY_ERRORS[code].status, code, HISTORY_ERRORS[code].message);

async function get(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: false });
  if ("response" in guard) return guard.response;

  const id = historyIdSchema.safeParse((await ctx.params).id);
  const query = historyQuerySchema.safeParse(
    Object.fromEntries(new URL(request.url).searchParams),
  );
  if (!id.success || !query.success) return fail("INVALID_INPUT");

  const page = await getPositionHistory(prisma, id.data, query.data);
  return page ? apiJson(page) : fail("POSITION_NOT_FOUND");
}

// The wrapper's handler takes only the request, so the context is closed over.
export const GET = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => get(req, ctx), logger)(request);
