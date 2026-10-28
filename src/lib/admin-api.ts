import "server-only";
import type { z } from "zod";
import type { User } from "@/generated/prisma/client";
import { can, type GlobalAction } from "@/lib/authz";
import { getSession } from "@/lib/auth/server";
import { MFA_ENROLLMENT_PATH, MFA_ERROR_CODES } from "@/lib/auth/mfa-policy";
import { setRequestUserId } from "@/lib/log/context";
import { PositionError, type PositionErrorCode } from "@/lib/positions";
import { prisma } from "@/lib/prisma";
import { limitRequest } from "@/lib/rate-limit/server";

const NO_STORE = { "Cache-Control": "no-store" };

/**
 * A `{ code, message }` error. `extra` carries further fields and can't
 * override `code` or `message`.
 */
export function apiError(
  status: number,
  code: string,
  message: string,
  extra: Record<string, unknown> = {},
): Response {
  return Response.json(
    { ...extra, code, message },
    { status, headers: NO_STORE },
  );
}

export function apiJson(body: unknown, init: { status?: number } = {}) {
  return Response.json(body, { ...init, headers: NO_STORE });
}

export type AdminActor = Pick<
  User,
  "id" | "isAdmin" | "isPrimaryAdmin" | "status" | "twoFactorEnabled"
>;

/**
 * The one admin API guard (#48, #54, #55, #58). Admin MFA is on by default.
 * Add options here; don't write a second guard.
 *
 * In order: session, a fresh actor row, `can(actor, action)`, admin MFA, then
 * the rate limit for mutations. A non-admin gets the authorization reason and
 * learns nothing about MFA; an MFA refusal uses no rate-limit token.
 *
 * `action` is the global action that gates the route and defaults to
 * `managePositions`. Any caller passing `requireMfa: false` must say why next
 * to the call.
 */
export async function requireAdmin({
  mutation,
  action = "managePositions",
  requireMfa = true,
}: {
  mutation: boolean;
  action?: GlobalAction;
  requireMfa?: boolean;
}): Promise<{ actor: AdminActor } | { response: Response }> {
  const unauthenticated = () =>
    ({
      response: apiError(401, "UNAUTHENTICATED", "Sign in to continue."),
    }) as const;

  const session = await getSession();
  if (!session) return unauthenticated();

  // The session carries no authority; the flags are read fresh every call.
  const actor = await prisma.user.findUnique({
    where: { id: session.user.id },
    select: {
      id: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      status: true,
      twoFactorEnabled: true,
    },
  });
  if (!actor) return unauthenticated();
  setRequestUserId(actor.id);

  const decision = can(actor, action);
  if (!decision.allowed) {
    return {
      response: apiError(
        403,
        decision.reason,
        "You do not have permission to do this.",
      ),
    };
  }

  if (requireMfa && !actor.twoFactorEnabled) {
    return {
      response: apiError(
        403,
        MFA_ERROR_CODES.MFA_REQUIRED.code,
        MFA_ERROR_CODES.MFA_REQUIRED.message,
        { enrollmentUrl: MFA_ENROLLMENT_PATH },
      ),
    };
  }

  if (mutation) {
    const limited = await limitRequest("adminMutation", actor.id);
    if (limited) return { response: limited };
  }

  return { actor };
}

const INVALID_INPUT_MESSAGE = "Check the highlighted fields and try again.";

/**
 * 400 INVALID_INPUT. `issues` names the failing paths and the schema's own
 * messages, never the input values; no error means an unparseable body.
 */
export function invalidInputResponse(error?: z.ZodError): Response {
  const issues = (error?.issues ?? []).map((issue) => ({
    path: issue.path.join("."),
    message: issue.message,
  }));
  return apiError(400, "INVALID_INPUT", INVALID_INPUT_MESSAGE, { issues });
}

/** A body that is not JSON, or does not match `schema`, is 400 INVALID_INPUT. */
export async function readJson<S extends z.ZodType>(
  request: Request,
  schema: S,
): Promise<{ data: z.output<S> } | { response: Response }> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return { response: invalidInputResponse() };
  }
  const parsed = schema.safeParse(body);
  return parsed.success
    ? { data: parsed.data }
    : { response: invalidInputResponse(parsed.error) };
}

// Exhaustive over PositionErrorCode, so a new code fails tsc until it has a row.
const POSITION_ERRORS: Record<
  PositionErrorCode,
  { status: number; message: string }
> = {
  INVALID_INPUT: { status: 400, message: INVALID_INPUT_MESSAGE },
  INVALID_KEY: {
    status: 400,
    message:
      "Keys use lowercase letters, numbers and single hyphens, 2–64 characters.",
  },
  KEY_IMMUTABLE: { status: 400, message: "A position's key can't be changed." },
  CONFIRM_KEY_MISMATCH: {
    status: 400,
    message: "Type the position's key exactly to confirm.",
  },
  POSITION_NOT_FOUND: { status: 404, message: "This position doesn't exist." },
  KEY_TAKEN: {
    status: 409,
    message: "Another position already uses this key.",
  },
  KEY_RETIRED: {
    status: 409,
    message:
      "This key belonged to a deleted position and can't be reused for 365 days.",
  },
  POSITION_DELETED: {
    status: 409,
    message: "This position has been deleted.",
  },
  POSITION_LIMIT: {
    status: 409,
    message: "This user already holds the maximum number of positions.",
  },
};

export function positionErrorResponse(err: PositionError): Response {
  const { status, message } = POSITION_ERRORS[err.code];
  return apiError(status, err.code, message);
}

export function positionNotFound(): Response {
  return positionErrorResponse(new PositionError("POSITION_NOT_FOUND"));
}
