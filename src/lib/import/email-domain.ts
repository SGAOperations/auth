// Pure on purpose: no `server-only`, no env and no database, so the import
// scripts, the dual-write endpoint and their tests share one rule.

export const NORTHEASTERN_DOMAIN = "northeastern.edu";

/** True only for an address ending in exactly `@northeastern.edu`. */
export function isNortheasternEmail(email: string): boolean {
  return email.trim().toLowerCase().endsWith(`@${NORTHEASTERN_DOMAIN}`);
}
