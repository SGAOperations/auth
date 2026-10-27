// Pure and client-safe: no `server-only`.

/** The name to show for a user: the preferred name when set, else the legal name. */
export function displayName({
  name,
  preferredName,
}: {
  name: string;
  preferredName?: string | null;
}): string {
  const preferred = preferredName?.trim();
  return preferred ? preferred : name;
}

/** Up to two uppercase letters from the first and last words, or "?" when empty. */
export function initials(display: string): string {
  const words = display.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "?";
  const first = words[0];
  const last = words.length > 1 ? words[words.length - 1] : "";
  return (
    Array.from(first)[0] + (last ? Array.from(last)[0] : "")
  ).toUpperCase();
}
