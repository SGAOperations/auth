import type { NextRequest } from "next/server";
import { z } from "zod";
import { apiError, apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import { declineTransfer } from "@/lib/jobs/pa-transfer-actions";
import {
  performTransition,
  transferIdSchema,
} from "@/lib/jobs/pa-transfer-http";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/transfer/[id]/decline";

type Ctx = { params: Promise<{ id: string }> };

// The recipient turns the transfer down. No re-authentication: declining only
// removes a pending privilege, the same effect the emailed cancel link has with
// no session at all.
async function post(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const transferId = transferIdSchema.safeParse((await ctx.params).id);
  if (!transferId.success) {
    return apiError(400, "INVALID_INPUT", "This transfer id isn't valid.");
  }
  const body = await readJson(request, z.strictObject({}));
  if ("response" in body) return body.response;

  const outcome = await performTransition((tx, now) =>
    declineTransfer(
      tx,
      { transferId: transferId.data, actorId: actor.id },
      now,
    ),
  );
  if ("response" in outcome) return outcome.response;

  const { id, status } = outcome.transfer;
  return apiJson({ transfer: { id, status } });
}

// The wrapper's handler takes only the request, so the context is closed over.
export const POST = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => post(req, ctx), logger)(request);
