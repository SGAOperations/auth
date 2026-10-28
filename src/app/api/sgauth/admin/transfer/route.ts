import { z } from "zod";
import { apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import { requireFreshAuth } from "@/lib/auth/server";
import { initiateTransfer } from "@/lib/jobs/pa-transfer-actions";
import { performTransition } from "@/lib/jobs/pa-transfer-http";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/transfer";

const bodySchema = z.strictObject({
  recipientUserId: z.uuid(),
  confirmEmail: z.string().min(1).max(320),
});

// Starts a Primary Admin transfer. Authority is checked in order: an active,
// MFA-enrolled admin, a fresh re-authentication, then `can(initiateTransfer)`
// inside the service. The proxy has already enforced Origin.
async function post(request: Request) {
  const guard = await requireAdmin({ mutation: true });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const fresh = await requireFreshAuth(request.headers);
  if (!fresh.ok) return fresh.response;

  const body = await readJson(request, bodySchema);
  if ("response" in body) return body.response;

  const outcome = await performTransition((tx, now) =>
    initiateTransfer(
      tx,
      {
        actor,
        recipientUserId: body.data.recipientUserId,
        confirmEmail: body.data.confirmEmail,
      },
      now,
    ),
  );
  if ("response" in outcome) return outcome.response;

  const { id, status, acceptanceExpiresAt } = outcome.transfer;
  return apiJson(
    { transfer: { id, status, acceptanceExpiresAt } },
    { status: 201 },
  );
}

export const POST = withRequestLogging(ROUTE, post, logger);
