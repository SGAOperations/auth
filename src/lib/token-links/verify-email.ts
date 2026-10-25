import "server-only";
import { isAPIError } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { z } from "zod";
import type { PrismaClient } from "@/generated/prisma/client";
import {
  TOKEN_ACTION_RESULTS,
  type TokenActionInput,
  type TokenActionOutcome,
  type TokenActionResult,
} from "@/lib/token-links/handler";
import {
  claimVerifyToken,
  isVerifyTokenUsed,
  releaseVerifyToken,
} from "@/lib/token-links/verify-email-token";

type VerifyEmailDb = Pick<PrismaClient, "usedEmailVerificationToken">;

const jwtPayload = z.object({ email: z.email(), exp: z.number() });

/**
 * Signature and expiry only, with no database read. `null` for anything that
 * is not a live verify token this server signed.
 */
export async function readVerifyToken(
  token: string,
  secret: string,
): Promise<{ email: string; expiresAt: Date } | null> {
  const payload = jwtPayload.safeParse(await verifyJWT(token, secret));
  if (!payload.success) return null;
  return {
    email: payload.data.email,
    expiresAt: new Date(payload.data.exp * 1000),
  };
}

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(TOKEN_ACTION_RESULTS).optional(),
});

export type VerifyEmailView =
  | { state: "ready"; token: string; email: string }
  | { state: TokenActionResult };

/**
 * What the GET page shows. Read-only by construction: it reads the single-use
 * record and never claims, so a scanner pre-fetch consumes nothing.
 */
export async function loadVerifyEmailView(
  searchParams: Record<string, string | string[] | undefined>,
  { secret, db }: { secret: string; db: VerifyEmailDb },
): Promise<VerifyEmailView> {
  const parsed = searchParamsSchema.safeParse(searchParams);
  if (!parsed.success) return { state: "invalid" };
  const { token, result } = parsed.data;
  if (result) return { state: result };
  if (!token) return { state: "invalid" };

  const read = await readVerifyToken(token, secret);
  if (!read) return { state: "invalid" };
  if (await isVerifyTokenUsed(db, token)) return { state: "used" };
  return { state: "ready", token, email: read.email };
}

interface VerifyEmailAuth {
  api: {
    verifyEmail(context: {
      query: { token: string };
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers }>;
  };
}

/**
 * The POST's `consume`. The claim comes before Better Auth runs, so a second
 * POST with the same token is answered `used` with no Better Auth call and no
 * side effects. Claiming and verifying cannot share a transaction, so the
 * order fails closed: any failure Better Auth reports releases the claim, and
 * a failed release leaves the link burned.
 */
export function createVerifyEmailConsumer({
  auth,
  db,
  secret,
}: {
  auth: VerifyEmailAuth;
  db: VerifyEmailDb;
  secret: string;
}): (input: TokenActionInput) => Promise<TokenActionOutcome> {
  return async function consume({ token, request }) {
    const read = await readVerifyToken(token, secret);
    // Nothing is written for a forged, malformed or expired token.
    if (!read) return { result: "invalid" };

    if ((await claimVerifyToken(db, token, read.expiresAt)) === "used") {
      return { result: "used" };
    }

    try {
      const { headers } = await auth.api.verifyEmail({
        query: { token },
        headers: request.headers,
        returnHeaders: true,
      });
      return { result: "done", headers };
    } catch (error) {
      // The verification did not happen, so the person may retry this link,
      // for example after INVALID_USER from someone else's session.
      await releaseVerifyToken(db, token);
      if (isAPIError(error)) return { result: "invalid" };
      throw error;
    }
  };
}
