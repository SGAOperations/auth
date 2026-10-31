"use server";

import { revalidatePath } from "next/cache";
import { headers } from "next/headers";
import { NextRequest } from "next/server";
import { z } from "zod";
import { PATCH as patchUserPositions } from "@/app/api/sgauth/admin/users/[id]/positions/route";
import { requireAdmin } from "@/lib/admin-api";
import type { ActionResult } from "@/lib/admin/action-result";
import { resultFromResponse } from "@/lib/admin/response-result";
import { revokeUserSession as revokeSession } from "@/lib/admin/user-sessions";
import { liveAdminUserHandlers } from "@/lib/admin/users/server";
import type { AdminUserAction } from "@/lib/admin/users/schemas";
import { getSession } from "@/lib/auth/server";
import { logger } from "@/lib/log";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";
import { prisma } from "@/lib/prisma";

// The one adapter between these pages and the admin user endpoints. Each action
// parses its input, calls the same handler the HTTP route runs, in-process and
// with the caller's cookie, and reads its answer back as an `ActionResult`. The
// handler owns the guard, `can()`, re-auth, the rate limit and the audit row;
// nothing here decides authorization. Next.js's Origin-against-Host check on
// Server Actions is the Origin rule, and none of these actions sets
// `allowedOrigins`.

const LIST_PATH = "/admin/users";

const userId = z.uuid();
const entityId = z.uuid();
const personName = z.string().trim().min(1).max(100);

const profileInput = z.strictObject({
  name: personName,
  preferredName: z
    .string()
    .trim()
    .max(100)
    .transform((value) => (value === "" ? null : value)),
});

const positionIds = z.array(entityId).min(1).max(MAX_ACTIVE_POSITIONS_PER_USER);

const invalid: ActionResult = { ok: false, code: "VALIDATION" };
const notFound: ActionResult = { ok: false, code: "NOT_FOUND" };

/** A request to the in-process handler, carrying what the guards read. */
async function internalRequest(
  path: string,
  method: "PATCH" | "POST",
  body?: unknown,
): Promise<NextRequest> {
  const incoming = await headers();
  const forwarded = new Headers({ "content-type": "application/json" });
  for (const name of [
    "cookie",
    "origin",
    "user-agent",
    "x-forwarded-for",
    "x-real-ip",
  ]) {
    const value = incoming.get(name);
    if (value) forwarded.set(name, value);
  }
  const host = incoming.get("host") ?? "localhost";
  return new NextRequest(`https://${host}${path}`, {
    method,
    headers: forwarded,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

function refresh(id: string) {
  revalidatePath(LIST_PATH);
  revalidatePath(`${LIST_PATH}/${id}`);
}

async function settle(id: string, response: Response): Promise<ActionResult> {
  const result = await resultFromResponse(response);
  if (result.ok || result.code === "NOT_FOUND") refresh(id);
  return result;
}

async function runUserAction(
  id: unknown,
  action: AdminUserAction,
): Promise<ActionResult> {
  const parsed = userId.safeParse(id);
  if (!parsed.success) return notFound;
  const request = await internalRequest(
    `/api/sgauth/admin/users/${parsed.data}/${action}`,
    "POST",
  );
  return settle(
    parsed.data,
    await liveAdminUserHandlers.action(request, {
      params: Promise.resolve({ id: parsed.data, action }),
    }),
  );
}

export async function updateProfile(
  id: unknown,
  values: unknown,
): Promise<ActionResult> {
  const parsedId = userId.safeParse(id);
  if (!parsedId.success) return notFound;
  const parsed = profileInput.safeParse(values);
  if (!parsed.success) return invalid;
  const request = await internalRequest(
    `/api/sgauth/admin/users/${parsedId.data}`,
    "PATCH",
    parsed.data,
  );
  return settle(
    parsedId.data,
    await liveAdminUserHandlers.update(request, {
      params: Promise.resolve({ id: parsedId.data }),
    }),
  );
}

export async function assignPositions(
  id: unknown,
  ids: unknown,
): Promise<ActionResult> {
  const parsedId = userId.safeParse(id);
  if (!parsedId.success) return notFound;
  const parsed = positionIds.safeParse(ids);
  if (!parsed.success) return invalid;
  const request = await internalRequest(
    `/api/sgauth/admin/users/${parsedId.data}/positions`,
    "PATCH",
    { assign: parsed.data },
  );
  return settle(
    parsedId.data,
    await patchUserPositions(request, {
      params: Promise.resolve({ id: parsedId.data }),
    }),
  );
}

export async function unassignPosition(
  id: unknown,
  positionId: unknown,
): Promise<ActionResult> {
  const parsedId = userId.safeParse(id);
  if (!parsedId.success) return notFound;
  const parsed = entityId.safeParse(positionId);
  if (!parsed.success) return invalid;
  const request = await internalRequest(
    `/api/sgauth/admin/users/${parsedId.data}/positions`,
    "PATCH",
    { unassign: [parsed.data] },
  );
  return settle(
    parsedId.data,
    await patchUserPositions(request, {
      params: Promise.resolve({ id: parsedId.data }),
    }),
  );
}

export async function grantAdmin(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "grant-admin");
}

export async function revokeAdmin(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "revoke-admin");
}

export async function deactivateUser(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "deactivate");
}

export async function reactivateUser(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "reactivate");
}

export async function unlockUser(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "unlock");
}

export async function resendInvite(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "resend-invite");
}

/** "Force re-login": ends every session of the user. */
export async function forceRelogin(id: unknown): Promise<ActionResult> {
  return runUserAction(id, "revoke-sessions");
}

export async function revokeUserSession(
  id: unknown,
  sessionId: unknown,
): Promise<ActionResult> {
  const guard = await requireAdmin({ mutation: true, action: "accessAdmin" });
  if ("response" in guard) return resultFromResponse(guard.response);

  const parsedId = userId.safeParse(id);
  if (!parsedId.success) return notFound;
  const parsedSession = entityId.safeParse(sessionId);
  if (!parsedSession.success) return notFound;

  // The caller's own current session is never revoked from here, whatever the
  // UI shows; "Sign out" ends it. The server is the control (ENGINEERING §3).
  const current = await getSession();
  if (current?.session.id === parsedSession.data) {
    return {
      ok: false,
      code: "CONFLICT",
      message: "You can't revoke the session you are signed in with.",
    };
  }

  try {
    const result = await revokeSession(prisma, guard.actor, {
      userId: parsedId.data,
      sessionId: parsedSession.data,
    });
    if (result.ok) {
      refresh(parsedId.data);
      return { ok: true };
    }
    if (result.code === "NOT_FOUND") {
      refresh(parsedId.data);
      return notFound;
    }
    return { ok: false, code: "FORBIDDEN", reason: result.reason };
  } catch (err) {
    logger.error("admin_session_revoke_failed", {
      errorName: err instanceof Error ? err.name : "unknown",
    });
    return { ok: false, code: "UNEXPECTED" };
  }
}
