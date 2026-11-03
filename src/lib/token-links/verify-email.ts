import "server-only";
import { isAPIError } from "better-auth/api";
import { verifyJWT } from "better-auth/crypto";
import { errors, jwtVerify } from "jose";
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
  isVerifyTokenRevoked,
  isVerifyTokenUsed,
  releaseVerifyToken,
} from "@/lib/token-links/verify-email-token";

type VerifyEmailDb = Pick<
  PrismaClient,
  "usedEmailVerificationToken" | "user" | "session" | "verification"
>;

const jwtPayload = z.object({
  email: z.email(),
  exp: z.number(),
  iat: z.number().optional(),
});

/**
 * Signature and expiry only, with no database read. `null` for anything that
 * is not a live verify token this server signed. `issuedAt` is the `iat` in
 * seconds, or 0 when absent, so such a token falls before any cutoff.
 */
export async function readVerifyToken(
  token: string,
  secret: string,
): Promise<{ email: string; expiresAt: Date; issuedAt: number } | null> {
  const payload = jwtPayload.safeParse(await verifyJWT(token, secret));
  if (!payload.success) return null;
  return {
    email: payload.data.email,
    expiresAt: new Date(payload.data.exp * 1000),
    issuedAt: payload.data.iat ?? 0,
  };
}

const expiredPayload = z.looseObject({ email: z.email() });

/**
 * The address in a plain verify token this server signed that has since
 * expired, or `null` for everything else, including a live token. jose checks
 * the signature before the claims, so the payload it attaches to a
 * `JWTExpired` is authentic. A change-email token (`updateTo`, `requestType`)
 * is never a plain verify token.
 */
export async function readExpiredVerifyToken(
  token: string,
  secret: string,
): Promise<{ email: string } | null> {
  try {
    await jwtVerify(token, new TextEncoder().encode(secret), {
      algorithms: ["HS256"],
    });
    return null;
  } catch (error) {
    if (!(error instanceof errors.JWTExpired)) return null;
    const payload = expiredPayload.safeParse(error.payload);
    if (!payload.success) return null;
    if ("updateTo" in payload.data || "requestType" in payload.data) {
      return null;
    }
    return { email: payload.data.email };
  }
}

async function isEmailVerified(
  db: VerifyEmailDb,
  email: string,
): Promise<boolean> {
  const user = await db.user.findUnique({
    where: { email },
    select: { emailVerified: true },
  });
  return user?.emailVerified === true;
}

const searchParamsSchema = z.object({
  token: z.string().max(4096).optional(),
  result: z.enum(TOKEN_ACTION_RESULTS).optional(),
});

export type VerifyEmailView =
  | { state: "ready"; token: string; email: string }
  // Carries the token so the page can offer a resend for its address.
  | { state: "expired"; token: string }
  | { state: TokenActionResult };

/**
 * What the GET page shows. Read-only by construction: it reads the single-use
 * record and the user row and never writes, so a scanner pre-fetch consumes
 * nothing. An address that is already verified shows as `used`, whichever of
 * its links is open.
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

  const live = await readVerifyToken(token, secret);
  const email =
    live?.email ?? (await readExpiredVerifyToken(token, secret))?.email;
  if (!email) return { state: "invalid" };

  if (await isVerifyTokenUsed(db, token)) return { state: "used" };
  if (await isEmailVerified(db, email)) return { state: "used" };
  if (!live) return { state: "expired", token };
  // Revoked by a repeat sign-up (repeat-signup.ts): the mailbox owner sets the
  // password through the set-password link instead.
  if (await isVerifyTokenRevoked(db, live)) return { state: "invalid" };
  return { state: "ready", token, email };
}

interface VerifyEmailAuth {
  api: {
    verifyEmail(context: {
      query: { token: string };
      headers: Headers;
      returnHeaders: true;
    }): Promise<{ headers: Headers }>;
    getSession(context: {
      headers: Headers;
      query: { disableRefresh: true };
    }): Promise<{ user: { email: string } } | null>;
  };
}

/** The signed-in user's address, or `null` with no usable session. */
async function signedInEmail(
  auth: VerifyEmailAuth,
  headers: Headers,
): Promise<string | null> {
  try {
    const session = await auth.api.getSession({
      headers,
      // Read only: no refresh, so no Set-Cookie to lose.
      query: { disableRefresh: true },
    });
    return session?.user.email ?? null;
  } catch (error) {
    // A deactivated user surfaces as an APIError from the after-hook.
    if (isAPIError(error)) return null;
    throw error;
  }
}

/**
 * The POST's `consume`. The claim comes before Better Auth runs, so a second
 * POST with the same token is answered `used` with no Better Auth call and no
 * side effects. Claiming and verifying cannot share a transaction, so the
 * order fails closed: any failure Better Auth reports releases the claim, and
 * a failed release leaves the link burned.
 *
 * A browser already signed in as someone else verifies the address but is not
 * signed in to it (black-team BT20). Otherwise Better Auth would replace that
 * session with one for the token's account, which is login CSRF: a victim who
 * clicks an attacker's link would be working in the attacker's account.
 */
export function createVerifyEmailConsumer({
  auth,
  db,
  secret,
  resolveRedirect,
}: {
  auth: VerifyEmailAuth;
  db: VerifyEmailDb;
  secret: string;
  /** Where to send the browser once the session is set (`consumeRedirect`). */
  resolveRedirect: () => Promise<string>;
}): (input: TokenActionInput) => Promise<TokenActionOutcome> {
  return async function consume({ token, request }) {
    const read = await readVerifyToken(token, secret);
    // Nothing is written for a forged, malformed or expired token.
    if (!read) return { result: "invalid" };

    // Better Auth answers an already-verified address with success and no
    // session, which would look like a login that never happened.
    if (await isEmailVerified(db, read.email)) return { result: "used" };
    // Issued before a repeat sign-up revoked the account's verify links. Read
    // before the claim, so nothing is written for it.
    if (await isVerifyTokenRevoked(db, read)) return { result: "invalid" };

    if ((await claimVerifyToken(db, token, read.expiresAt)) === "used") {
      return { result: "used" };
    }

    const current = await signedInEmail(auth, request.headers);
    const otherUser = current !== null && current !== read.email;
    const startedAt = new Date();

    let headers: Headers;
    try {
      ({ headers } = await auth.api.verifyEmail({
        query: { token },
        // No cookies for another user's browser: Better Auth sees no session.
        headers: otherUser ? new Headers() : request.headers,
        returnHeaders: true,
      }));
    } catch (error) {
      // The verification did not happen, so the person may retry this link.
      await releaseVerifyToken(db, token);
      if (isAPIError(error)) return { result: "invalid" };
      throw error;
    }

    if (otherUser) {
      // The auto-sign-in session's cookie is never sent, so its row goes too.
      await db.session.deleteMany({
        where: { user: { email: read.email }, createdAt: { gte: startedAt } },
      });
      return { result: "done" };
    }

    // The address is verified and the session headers are in hand, so a throw
    // here must not lose them. Without a `redirectTo` the handler lands on its
    // own done page, still carrying the session cookies.
    let redirectTo: string | undefined;
    try {
      redirectTo = await resolveRedirect();
    } catch {
      redirectTo = undefined;
    }
    return { result: "done", headers, redirectTo };
  };
}

interface ResendVerifyEmailAuth {
  api: {
    sendVerificationEmail(context: {
      body: { email: string };
    }): Promise<unknown>;
  };
}

/**
 * The resend POST's `consume`, for a link that has expired. The address comes
 * from the signed token, never from the form. It never reads the user row, so
 * `sent` is the same whether or not the account exists or is already verified;
 * Better Auth mails only an unverified account. The send takes no headers,
 * which keeps it on Better Auth's no-session branch, so an unrelated signed-in
 * session can never turn it into an error. Resending shares the HTTP
 * endpoint's `verify:email:1h` bucket.
 */
export function createResendVerifyEmailConsumer({
  auth,
  secret,
  limit,
}: {
  auth: ResendVerifyEmailAuth;
  secret: string;
  /** `false` once the address has used its resends for the window. */
  limit: (email: string) => Promise<boolean>;
}): (input: TokenActionInput) => Promise<TokenActionOutcome> {
  return async function consume({ token }) {
    const read =
      (await readVerifyToken(token, secret)) ??
      (await readExpiredVerifyToken(token, secret));
    if (!read) return { result: "invalid" };

    if (!(await limit(read.email))) return { result: "rate" };

    await auth.api.sendVerificationEmail({ body: { email: read.email } });
    return { result: "sent" };
  };
}
