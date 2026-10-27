import { REAUTH_ERROR_CODES } from "@/lib/auth/reauth-policy";

// Client-safe: no env, no DB.

interface FetchWithReauthOptions {
  /** Opens the re-auth prompt. Resolves true once the session is fresh. */
  onReauthRequired: () => Promise<boolean>;
  fetch?: typeof fetch;
}

async function isReauthRequired(response: Response): Promise<boolean> {
  if (response.status !== 403) return false;
  try {
    const body: unknown = await response.clone().json();
    return (
      typeof body === "object" &&
      body !== null &&
      "code" in body &&
      body.code === REAUTH_ERROR_CODES.REAUTH_REQUIRED.code
    );
  } catch {
    return false;
  }
}

/**
 * `fetch` that answers a 403 `REAUTH_REQUIRED` by prompting for credentials and
 * retrying the request once. A second `REAUTH_REQUIRED` goes back to the caller
 * as it is, with no loop, and so does the original 403 when the prompt is
 * cancelled. Every other response passes through untouched.
 *
 * `init.body` must be re-sendable, because the request can go out twice: a
 * string or `FormData`, never a stream.
 */
export async function fetchWithReauth(
  input: RequestInfo | URL,
  init: RequestInit | undefined,
  { onReauthRequired, fetch: send = fetch }: FetchWithReauthOptions,
): Promise<Response> {
  const first = await send(input, init);
  if (!(await isReauthRequired(first))) return first;
  if (!(await onReauthRequired())) return first;
  return send(input, init);
}
