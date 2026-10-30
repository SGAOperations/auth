import type { ActionResult, FailureCode } from "@/lib/admin/action-result";
import { isDenialReason } from "@/lib/admin/denial-copy";
import { REAUTH_ERROR_CODES } from "@/lib/auth/reauth-policy";
import type { AuthzDenialReason } from "@/lib/authz";

// Pure. The admin API answers `{ code, message }` with a status; the pages call
// the same handlers in-process, so this is the one place that turns an answer
// into the `ActionResult` the client reads.

const CODE_FAILURES: Record<string, FailureCode> = {
  POSITION_LIMIT: "POSITION_LIMIT",
  POSITION_DELETED: "POSITION_DELETED",
  POSITION_NOT_FOUND: "NOT_FOUND",
  USER_NOT_FOUND: "NOT_FOUND",
  UNKNOWN_ACTION: "NOT_FOUND",
  INVALID_INPUT: "VALIDATION",
  INVITE_LIMIT: "RATE_LIMITED",
  RATE_LIMITED: "RATE_LIMITED",
};

function failureFor(
  status: number,
  code: string | undefined,
): { code: FailureCode; reason?: AuthzDenialReason } {
  if (code === REAUTH_ERROR_CODES.REAUTH_REQUIRED.code) {
    return { code: "REAUTH_REQUIRED" };
  }
  if (isDenialReason(code)) return { code: "FORBIDDEN", reason: code };
  if (code !== undefined && Object.hasOwn(CODE_FAILURES, code)) {
    return { code: CODE_FAILURES[code] };
  }
  if (status === 401 || status === 403) return { code: "FORBIDDEN" };
  if (status === 404) return { code: "NOT_FOUND" };
  if (status === 400) return { code: "VALIDATION" };
  if (status === 429) return { code: "RATE_LIMITED" };
  if (status === 409) return { code: "CONFLICT" };
  return { code: "UNEXPECTED" };
}

async function readBody(
  response: Response,
): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json();
    return typeof body === "object" && body !== null && !Array.isArray(body)
      ? (body as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

/** The result of one admin API response, success or failure. */
export async function resultFromResponse(
  response: Response,
): Promise<ActionResult> {
  const body = await readBody(response);
  if (response.ok) {
    return typeof body?.email === "string"
      ? { ok: true, email: body.email }
      : { ok: true };
  }
  const code = typeof body?.code === "string" ? body.code : undefined;
  const failure = failureFor(response.status, code);
  const message = typeof body?.message === "string" ? body.message : undefined;
  return {
    ok: false,
    ...failure,
    ...(failure.code === "CONFLICT" && message ? { message } : {}),
  };
}
