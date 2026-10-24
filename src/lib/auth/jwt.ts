import "server-only";
import { APIError } from "better-auth/api";
import { jwt } from "better-auth/plugins";
import type { PrismaClient } from "@/generated/prisma/client";
import { AUTH_ERROR_CODES } from "@/lib/auth/policy";
import {
  JWKS_GRACE_PERIOD_SECONDS,
  JWT_ALG,
  JWT_AUDIENCE,
  JWT_EXPIRATION,
} from "@/lib/auth/jwt-constants";

export interface TokenClaims {
  email: string;
  name: string;
  status: string;
  isAdmin: boolean;
  isPrimaryAdmin: boolean;
  /** Keys of the user's active (not soft-deleted) positions, in any order. */
  positionKeys: string[];
}

/**
 * Reads the claims fresh from the database: `session.user` carries neither the
 * admin flags nor the positions. Returns null for a missing user.
 */
export async function loadTokenClaims(
  db: Pick<PrismaClient, "user">,
  userId: string,
): Promise<TokenClaims | null> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: {
      email: true,
      name: true,
      status: true,
      isAdmin: true,
      isPrimaryAdmin: true,
      positions: {
        where: { position: { deletedAt: null } },
        select: { position: { select: { key: true } } },
      },
    },
  });
  if (!user) return null;
  const { positions, ...rest } = user;
  return { ...rest, positionKeys: positions.map((p) => p.position.key) };
}

/**
 * The token payload. `/token` runs Better Auth's session middleware, which
 * bypasses the `/get-session` hook that rejects a deactivated user, so the
 * status is checked here.
 */
export function toTokenPayload(claims: TokenClaims | null) {
  if (!claims || claims.status !== "ACTIVE") {
    throw APIError.from("UNAUTHORIZED", AUTH_ERROR_CODES.ACCOUNT_DEACTIVATED);
  }
  return {
    email: claims.email,
    name: claims.name,
    // Supabase maps the request to this Postgres role.
    role: "authenticated",
    positions: [...claims.positionKeys].sort(),
    is_admin: claims.isAdmin,
    is_primary_admin: claims.isPrimaryAdmin,
  };
}

interface JwtPluginInput {
  prisma: PrismaClient;
  /** The environment's base URL, without a trailing slash. */
  issuer: string;
}

/**
 * Mounts `/jwks` and `/token`. Rotation is manual (scripts/jwks-rotate.ts), so
 * there is no `rotationInterval`: Supabase learns of a new key only when it
 * re-fetches the JWKS, and an automatic rotation would reject fresh tokens
 * until then. Private keys stay encrypted at rest (the default).
 */
export function buildJwtPlugin({ prisma, issuer }: JwtPluginInput) {
  return jwt({
    jwks: {
      keyPairConfig: { alg: JWT_ALG },
      gracePeriod: JWKS_GRACE_PERIOD_SECONDS,
    },
    jwt: {
      issuer,
      audience: JWT_AUDIENCE,
      expirationTime: JWT_EXPIRATION,
      getSubject: (session) => session.user.id,
      definePayload: async (session) =>
        toTokenPayload(await loadTokenClaims(prisma, session.user.id)),
    },
    // Otherwise every /get-session call mints a JWT into a `set-auth-jwt`
    // header, which sidesteps the /token rate limit and puts a bearer token on
    // the session hot path.
    disableSettingJwtHeader: true,
  });
}

/** The minimal OIDC discovery document Supabase needs to find the key set. */
export function buildOpenIdConfiguration(issuer: string) {
  return {
    issuer,
    jwks_uri: `${issuer}/api/auth/jwks`,
    id_token_signing_alg_values_supported: [JWT_ALG],
    subject_types_supported: ["public"],
  };
}
