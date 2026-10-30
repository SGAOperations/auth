import { z } from "zod";
import { apiJson, readJson, requireAdmin } from "@/lib/admin-api";
import { denied, userError } from "@/lib/admin/users/http";
import { userIdParam } from "@/lib/admin/users/schemas";
import { auditRequestInfo } from "@/lib/audit";
import { requireFreshAuth } from "@/lib/auth/server";
import { emailChangeService } from "@/lib/email-change/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/users/[id]/email";

const bodySchema = z.strictObject({
  newEmail: z.string().trim().toLowerCase().pipe(z.email().max(254)),
});

type Ctx = { params: Promise<{ id: string }> };

// Starts an admin-initiated email change (AUTH-T24). In order: the admin guard,
// a fresh re-authentication, then input, then the service, which loads the
// target and runs `can(changeEmail)`. Re-authentication comes first, so every
// case answers REAUTH_REQUIRED when the stamp is stale, whatever the target. The
// proxy has already enforced Origin. Nothing changes on the user until the new
// mailbox confirms.
async function post(request: Request, ctx: Ctx) {
  const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const fresh = await requireFreshAuth(request.headers);
  if (!fresh.ok) return fresh.response;

  // A malformed id looks the same as an unknown one.
  const id = userIdParam.safeParse((await ctx.params).id);
  if (!id.success) return userError("USER_NOT_FOUND");

  const body = await readJson(request, bodySchema);
  if ("response" in body) return body.response;

  const result = await emailChangeService.requestEmailChange({
    actor,
    targetId: id.data,
    newEmail: body.data.newEmail,
    requestContext: auditRequestInfo(request.headers),
  });
  if (result.ok) {
    return apiJson(
      {
        status: "PENDING_VERIFICATION",
        expiresAt: result.expiresAt.toISOString(),
      },
      { status: 202 },
    );
  }
  switch (result.code) {
    case "FORBIDDEN":
      return denied(result.reason);
    case "NOT_FOUND":
      return userError("USER_NOT_FOUND");
    default:
      return userError(result.code);
  }
}

export const POST = (request: Request, ctx: Ctx) =>
  withRequestLogging(ROUTE, (req) => post(req, ctx), logger)(request);
