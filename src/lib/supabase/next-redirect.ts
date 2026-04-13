/**
 * `next` is supplied by our app when building magic-link URLs, e.g.
 * `emailRedirectTo: `${origin}/auth/callback?next=${encodeURIComponent(returnPath)}``.
 * Only same-origin path redirects are allowed (blocks open redirects).
 */
export function getSafeNextPath(raw: string | null): string {
  const fallback = "/";
  if (raw == null || raw === "") {
    return fallback;
  }
  const trimmed = raw.trim();
  if (trimmed === "") {
    return fallback;
  }
  if (trimmed.includes("://") || trimmed.startsWith("//")) {
    return fallback;
  }
  return trimmed.startsWith("/") ? trimmed : `/${trimmed}`;
}
