import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { REAUTH_ERROR_CODES, isFresh } from "@/lib/auth/reauth-policy";

// The guard for sensitive actions (docs/REAUTH.md). It reads `lastReauthAt`
// from the database on every call: the column is not a Better Auth session
// field, so the session object never carries it.

const NO_STORE = { "Cache-Control": "no-store" };

/** For callers that already hold the session. A missing row is not fresh. */
export async function hasFreshAuth(
  db: Pick<PrismaClient, "session">,
  sessionId: string,
  now: Date = new Date(),
): Promise<boolean> {
  const row = await db.session.findUnique({
    where: { id: sessionId },
    select: { lastReauthAt: true },
  });
  return row ? isFresh(row.lastReauthAt, now) : false;
}

export function reauthRequiredResponse(): Response {
  return Response.json(REAUTH_ERROR_CODES.REAUTH_REQUIRED, {
    status: 403,
    headers: NO_STORE,
  });
}

interface FreshAuthGuardInput<S extends { session: { id: string } }> {
  getSession: (headers: Headers) => Promise<S | null>;
  prisma: Pick<PrismaClient, "session">;
}

export type FreshAuthResult<S> =
  | { ok: true; session: S }
  | { ok: false; response: Response };

/**
 * `requireFreshAuth(headers)`. Call it in a sensitive route handler after the
 * Origin check and before `can()`. 401 for no session, 403 `REAUTH_REQUIRED`
 * when the session has not re-authenticated within the window.
 */
export function createFreshAuthGuard<S extends { session: { id: string } }>({
  getSession,
  prisma,
}: FreshAuthGuardInput<S>) {
  return async function requireFreshAuth(
    headers: Headers,
  ): Promise<FreshAuthResult<S>> {
    const session = await getSession(headers);
    if (!session) {
      return {
        ok: false,
        response: Response.json(
          { code: "UNAUTHORIZED", message: "Sign in to continue." },
          { status: 401, headers: NO_STORE },
        ),
      };
    }
    if (!(await hasFreshAuth(prisma, session.session.id))) {
      return { ok: false, response: reauthRequiredResponse() };
    }
    return { ok: true, session };
  };
}
