import "server-only";

/**
 * The origin the browser says a form was posted from: `Origin`, else the
 * `Referer`'s origin. `null` when neither is usable, which callers treat as a
 * failure (ENGINEERING §3).
 */
export function requestOrigin(request: Request): string | null {
  const origin = request.headers.get("origin");
  if (origin) return origin;
  const referer = request.headers.get("referer");
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}
