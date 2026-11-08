import "server-only";
import { APIError } from "better-auth/api";
import type { PrismaClient } from "@/generated/prisma/client";
import type { RateLimiter } from "@/lib/rate-limit/limiter";
import {
  SESSION_RESPONSE_HEADERS,
  UNAUTHENTICATED_BODY,
} from "@/lib/sgauth-session/contract";
import { canUseProducts } from "@/lib/authz";
import { countCookie } from "@/lib/security/duplicate-cookie";
import {
  pickSessionCookies,
  sessionTokenValue,
  sortPositions,
  toMinimalResponse,
  toSessionResponse,
  type SessionRow,
  type SessionSubject,
} from "@/lib/sgauth-session/mapping";

// Contract and caller rules: docs/SESSION-ENDPOINT.md.

type Shape = "full" | "minimal";

export interface SessionEndpointDeps {
  /** The session token name first, then the dont-remember name. */
  cookieNames(): Promise<readonly string[]>;
  getSession(
    headers: Headers,
  ): Promise<{ session: SessionRow & { userId: string } } | null>;
  loadSubject(userId: string): Promise<SessionSubject | null>;
  /** Returns the 429 to send, or `null` to carry on. */
  limit(token: string): Promise<Response | null>;
  log: { warn(msg: string, fields?: Record<string, unknown>): void };
  /** The leadership Slack-link mandate (#361). */
  slackMandate: {
    enabled: boolean;
    /** Audits a refusal. Best effort: it must not throw. */
    recordBlock(userId: string): Promise<void>;
  };
}

function unauthenticated(): Response {
  return Response.json(UNAUTHENTICATED_BODY, {
    status: 401,
    headers: SESSION_RESPONSE_HEADERS,
  });
}

function withSessionHeaders(response: Response): Response {
  for (const [name, value] of Object.entries(SESSION_RESPONSE_HEADERS)) {
    response.headers.set(name, value);
  }
  return response;
}

export function createSessionEndpoint(deps: SessionEndpointDeps) {
  async function resolve(req: Request, shape: Shape): Promise<Response> {
    // Cookie header only: the URL, query string, Authorization header and body
    // are never read.
    const names = await deps.cookieNames();
    // More than one session cookie means a planted copy beside the victim's:
    // signed out, before any limit, Better Auth or database call.
    const copies = countCookie(req.headers.get("cookie"), names[0]);
    if (copies > 1) {
      deps.log.warn("Refused duplicate session cookie", {
        path: new URL(req.url).pathname,
        copies,
      });
      return unauthenticated();
    }
    const cookie = pickSessionCookies(req.headers.get("cookie"), names);
    if (cookie === null) return unauthenticated();

    const token = sessionTokenValue(cookie, names[0]);
    if (token === null) return unauthenticated();
    const limited = await deps.limit(token);
    if (limited) return withSessionHeaders(limited);

    let result: Awaited<ReturnType<SessionEndpointDeps["getSession"]>>;
    try {
      result = await deps.getSession(new Headers({ cookie }));
    } catch (error) {
      // The deactivation after-hook in options.ts throws this.
      if (error instanceof APIError && error.status === "UNAUTHORIZED") {
        return unauthenticated();
      }
      throw error;
    }
    if (!result) return unauthenticated();

    // A fresh read, a second line behind the /get-session hook.
    const { session } = result;
    const subject = await deps.loadSubject(session.userId);
    if (!subject || subject.status !== "ACTIVE") return unauthenticated();

    // A refusal looks exactly like signed out, so the SDK sends the browser to
    // /login, which says why. Admin status grants nothing here.
    const access = canUseProducts({ ...subject, status: "ACTIVE" }, subject, {
      slackMandateEnabled: deps.slackMandate.enabled,
    });
    if (!access.allowed) {
      // The audit is best effort: a broken dep must never become a 500, which
      // the SDK would answer with a stale session.
      try {
        await deps.slackMandate.recordBlock(session.userId);
      } catch {
        deps.log.warn("slack_mandate_block_unaudited", { surface: "session" });
      }
      return unauthenticated();
    }

    const body =
      shape === "full"
        ? toSessionResponse({ subject, session })
        : toMinimalResponse({ subject });
    return Response.json(body, { headers: SESSION_RESPONSE_HEADERS });
  }

  return {
    full: (req: Request) => resolve(req, "full"),
    minimal: (req: Request) => resolve(req, "minimal"),
  };
}

/** The minimum surface of the Better Auth instance this endpoint needs. */
export interface SessionAuth {
  api: {
    getSession(context: {
      headers: Headers;
    }): Promise<{ session: SessionRow & { userId: string } } | null>;
  };
  $context: Promise<{
    authCookies: {
      sessionToken: { name: string };
      dontRememberToken: { name: string };
    };
  }>;
}

export function buildSessionEndpointDeps({
  auth,
  prisma,
  limiter,
  log,
  slackMandate = { enabled: false, recordBlock: async () => undefined },
}: {
  auth: SessionAuth;
  prisma: PrismaClient;
  limiter: Pick<RateLimiter, "limitRequest">;
  log: SessionEndpointDeps["log"];
  /** Leaving it out means the mandate is off. */
  slackMandate?: SessionEndpointDeps["slackMandate"];
}): SessionEndpointDeps {
  // The names Better Auth itself reads, so they cannot drift from cookies.ts.
  let cookieNames: Promise<readonly string[]> | undefined;

  return {
    cookieNames: () =>
      (cookieNames ??= auth.$context.then(({ authCookies }) => [
        authCookies.sessionToken.name,
        authCookies.dontRememberToken.name,
      ])),
    getSession: (headers) => auth.api.getSession({ headers }),
    async loadSubject(userId) {
      const user = await prisma.user.findUnique({
        where: { id: userId },
        select: {
          id: true,
          email: true,
          name: true,
          preferredName: true,
          isAdmin: true,
          isPrimaryAdmin: true,
          status: true,
          positions: {
            where: { position: { deletedAt: null } },
            select: {
              position: {
                select: { key: true, name: true, isLeadership: true },
              },
            },
          },
          slackUserToken: { select: { userId: true } },
        },
      });
      if (!user) return null;
      const { positions, slackUserToken, ...rest } = user;
      return {
        ...rest,
        positions: sortPositions(
          positions.map(({ position }) => ({
            key: position.key,
            name: position.name,
          })),
        ),
        isLeadership: positions.some(({ position }) => position.isLeadership),
        hasSlackProfileAccess: slackUserToken !== null,
      };
    },
    limit: (token) => limiter.limitRequest("sessionLookup", token),
    log,
    slackMandate,
  };
}
