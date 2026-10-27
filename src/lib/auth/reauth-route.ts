import "server-only";
import { reauthBodySchema, type ReauthBody } from "@/lib/auth/reauth-policy";

const NO_STORE = { "Cache-Control": "no-store" };

interface ReauthRouteInput {
  getSession: (headers: Headers) => Promise<{ user: { id: string } } | null>;
  /** The per-user rate limit: a `Response` to return as is, or null. */
  limit: (userId: string) => Promise<Response | null>;
  /** The credential check, which stamps the session. */
  reauthenticate: (input: {
    headers: Headers;
    body: ReauthBody;
  }) => Promise<Response>;
}

const invalidRequest = () =>
  Response.json(
    { code: "INVALID_REQUEST", message: "Invalid request." },
    { status: 400, headers: NO_STORE },
  );

/**
 * `POST /api/sgauth/reauth`. A thin shell: the session, the rate limit and the
 * body shape are settled here, and the credential check is the plugin
 * endpoint's. Origin enforcement is the proxy's, which covers `/api/sgauth/*`.
 */
export function createReauthRoute({
  getSession,
  limit,
  reauthenticate,
}: ReauthRouteInput) {
  return async function POST(request: Request): Promise<Response> {
    const session = await getSession(request.headers);
    if (!session) {
      return Response.json(
        { code: "UNAUTHORIZED", message: "Sign in to continue." },
        { status: 401, headers: NO_STORE },
      );
    }

    const limited = await limit(session.user.id);
    if (limited) return limited;

    let json: unknown;
    try {
      json = await request.json();
    } catch {
      return invalidRequest();
    }
    const body = reauthBodySchema.safeParse(json);
    if (!body.success) return invalidRequest();

    const response = await reauthenticate({
      headers: request.headers,
      body: body.data,
    });
    const result = new Response(response.body, response);
    result.headers.set("Cache-Control", "no-store");
    return result;
  };
}
