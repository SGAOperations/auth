import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import { requireFreshAuth } from "@/lib/auth/server";
import { cancelTransfer } from "@/lib/jobs/pa-transfer-actions";
import {
  performTransition,
  transferIdSchema,
} from "@/lib/jobs/pa-transfer-http";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/transfer/[id]/cancel";

type Ctx = { params: Promise<{ id: string }> };

// The sending Primary Admin withdraws the transfer from inside the app. The
// emailed cancel link is the other way, with no session (/transfer/cancel).
async function post(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const fresh = await requireFreshAuth(request.headers);
  if (!fresh.ok) return fresh.response;

  const transferId = transferIdSchema.safeParse((await ctx.params).id);
  if (!transferId.success) {
    return apiError(400, "INVALID_INPUT", "This transfer id isn't valid.");
  }
  const body = await readJson(request, z.strictObject({}));
  if ("response" in body) return body.response;

  const outcome = await performTransition((tx, now) =>
    cancelTransfer(tx, { transferId: transferId.data, actorId: actor.id }, now),
  );
  if ("response" in outcome) return outcome.response;

  const { id, status } = outcome.transfer;
  return apiJson({ transfer: { id, status } });
}

// The wrapper's handler takes only the request, so the context is closed over.
export const POST = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => post(req, ctx), logger)(request);
