import { z } from "zod";
import { REAUTH_ERROR_CODES } from "@/lib/auth/reauth-policy";

// Client-safe: no env, no DB. The one place the transfer screens call the
// transfer routes, so every screen reads their answers the same way.

export type Send = (
  input: RequestInfo | URL,
  init?: RequestInit,
) => Promise<Response>;

export type TransferActionResult =
  | { kind: "ok"; id: string }
  /** The session is not fresh and the re-authentication prompt did not finish. */
  | { kind: "reauth" }
  /** A refusal the route named: `code` is one of its error codes. */
  | { kind: "error"; code: string; reason?: string }
  /** A network failure, a 5xx, or a body that is not what the routes send. */
  | { kind: "unexpected" };

const successSchema = z.object({ transfer: z.object({ id: z.string() }) });
const errorSchema = z.object({
  code: z.string(),
  reason: z.string().optional(),
});

async function readBody(response: Response): Promise<unknown> {
  try {
    return await response.json();
  } catch {
    return undefined;
  }
}

/**
 * POSTs a JSON body to a transfer route. Pass the re-authentication-aware
 * `fetch` from `useReauth()` as `send`, so a stale session prompts and retries.
 */
export async function postTransferAction(
  path: string,
  body: Record<string, unknown>,
  send: Send = fetch,
): Promise<TransferActionResult> {
  let response: Response;
  try {
    response = await send(path, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch {
    return { kind: "unexpected" };
  }

  const json = await readBody(response);
  if (response.ok) {
    const parsed = successSchema.safeParse(json);
    return parsed.success
      ? { kind: "ok", id: parsed.data.transfer.id }
      : { kind: "unexpected" };
  }

  if (response.status === 429) return { kind: "error", code: "RATE_LIMITED" };
  if (response.status >= 500) return { kind: "unexpected" };

  const parsed = errorSchema.safeParse(json);
  if (!parsed.success) return { kind: "unexpected" };
  if (
    response.status === 403 &&
    parsed.data.code === REAUTH_ERROR_CODES.REAUTH_REQUIRED.code
  ) {
    return { kind: "reauth" };
  }
  return { kind: "error", ...parsed.data };
}
