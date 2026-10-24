// Pure data, like env-schema.ts: no `server-only`, no `@/` imports, no env. The
// jwt plugin config (jwt.ts) and the JWKS rotation tool (prisma/seed and
// scripts, which cannot import server-only code) both read it.

/** The only signing algorithm: Supabase third-party auth accepts ES256. */
export const JWT_ALG = "ES256";

/** Matches Supabase's own token convention, so any audience check passes. */
export const JWT_AUDIENCE = "authenticated";

export const JWT_EXPIRATION = "10m";

/** How long a rotated-out key stays published, so tokens it signed still verify. */
export const JWKS_GRACE_PERIOD_SECONDS = 7 * 24 * 60 * 60;

/**
 * `createdAt` of a key that is published in the JWKS but never signs. The jwt
 * plugin signs with the newest live key, so a key created at the epoch can
 * never be that key until `activate` moves its `createdAt` to now.
 */
export const STAGED_KEY_CREATED_AT = new Date(0);
