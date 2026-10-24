// Pure CORS rules for browser calls from registered product origins. No env,
// no Prisma, no `@/` imports, like csp.ts; the wiring is in cors-server.ts.
// Contract: docs/CORS.md.

type CorsMethod = "GET" | "POST";

// /api/auth/token is deliberately absent: browsers reach the token only
// through a product-side server proxy. Do not add it back.
export const CORS_ROUTES: ReadonlyMap<string, readonly CorsMethod[]> = new Map([
  ["/api/sgauth/session", ["GET"]],
  ["/api/sgauth/session/minimal", ["GET"]],
  ["/api/auth/sign-out", ["POST"]],
]);

export const CORS_ALLOWED_HEADERS: readonly string[] = ["content-type"];
export const CORS_EXPOSED_HEADERS: readonly string[] = ["Retry-After"];
export const CORS_MAX_AGE_SECONDS = 600;

const PREFLIGHT_VARY = [
  "Origin",
  "Access-Control-Request-Method",
  "Access-Control-Request-Headers",
];

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

/** Methods a CORS-enabled path allows, or null. Exact match, no prefixes. */
export function corsMethodsFor(pathname: string): readonly string[] | null {
  return CORS_ROUTES.get(stripTrailingSlash(pathname)) ?? null;
}

export function isCorsPreflight(method: string, pathname: string): boolean {
  return method === "OPTIONS" && corsMethodsFor(pathname) !== null;
}

/** The matching trusted entry (never the raw header), or null. */
export function matchOrigin(
  origin: string | null,
  trusted: readonly string[],
): string | null {
  if (!origin || origin === "null") return null;
  return trusted.find((entry) => entry === origin) ?? null;
}

/** Merges tokens into `Vary`, de-duplicating case-insensitively. */
export function appendVary(headers: Headers, ...tokens: string[]): void {
  const existing = headers.get("Vary");
  if (existing?.trim() === "*") return;
  const merged = existing
    ? existing
        .split(",")
        .map((token) => token.trim())
        .filter(Boolean)
    : [];
  for (const token of tokens) {
    if (!merged.some((m) => m.toLowerCase() === token.toLowerCase())) {
      merged.push(token);
    }
  }
  headers.set("Vary", merged.join(", "));
}

/** A new response with `Vary: Origin`, plus CORS headers for a match. */
export function decorate(
  response: Response,
  allowedOrigin: string | null,
): Response {
  const headers = new Headers(response.headers);
  appendVary(headers, "Origin");
  if (allowedOrigin !== null) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set(
      "Access-Control-Expose-Headers",
      CORS_EXPOSED_HEADERS.join(", "),
    );
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function headersAllowed(requestHeaders: string | null): boolean {
  if (!requestHeaders) return true;
  return requestHeaders
    .split(",")
    .map((token) => token.trim().toLowerCase())
    .filter(Boolean)
    .every((token) => CORS_ALLOWED_HEADERS.includes(token));
}

export function buildPreflight(input: {
  methods: readonly string[];
  allowedOrigin: string | null;
  requestMethod: string | null;
  requestHeaders: string | null;
}): Response {
  const { methods, allowedOrigin, requestMethod, requestHeaders } = input;
  const headers = new Headers({
    Vary: PREFLIGHT_VARY.join(", "),
    "Cache-Control": "no-store",
    Allow: [...methods, "OPTIONS"].join(", "),
  });
  if (
    allowedOrigin !== null &&
    requestMethod !== null &&
    methods.includes(requestMethod) &&
    headersAllowed(requestHeaders)
  ) {
    headers.set("Access-Control-Allow-Origin", allowedOrigin);
    headers.set("Access-Control-Allow-Credentials", "true");
    headers.set("Access-Control-Allow-Methods", methods.join(", "));
    headers.set("Access-Control-Allow-Headers", "Content-Type");
    headers.set("Access-Control-Max-Age", String(CORS_MAX_AGE_SECONDS));
  }
  return new Response(null, { status: 204, headers });
}

export interface CorsDeps {
  trustedOrigins: (request: Request) => Promise<readonly string[]>;
  log: { error: (msg: string, fields?: Record<string, unknown>) => void };
}

export function createCors({ trustedOrigins, log }: CorsDeps) {
  // Fails closed: a registry error is logged (name only) and means no match.
  async function resolve(request: Request, origin: string) {
    try {
      return matchOrigin(origin, await trustedOrigins(request));
    } catch (error) {
      log.error("CORS could not load trusted origins", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      return null;
    }
  }

  function withCors(
    handler: (req: Request) => Promise<Response>,
  ): (req: Request) => Promise<Response> {
    return async (req) => {
      const response = await handler(req);
      if (corsMethodsFor(new URL(req.url).pathname) === null) return response;
      const origin = req.headers.get("Origin");
      return decorate(response, origin ? await resolve(req, origin) : null);
    };
  }

  async function preflight(req: Request): Promise<Response> {
    const methods = corsMethodsFor(new URL(req.url).pathname);
    if (methods === null) {
      return new Response(null, {
        status: 204,
        headers: { Allow: "GET, POST, OPTIONS" },
      });
    }
    const origin = req.headers.get("Origin");
    return buildPreflight({
      methods,
      allowedOrigin: origin ? await resolve(req, origin) : null,
      requestMethod: req.headers.get("Access-Control-Request-Method"),
      requestHeaders: req.headers.get("Access-Control-Request-Headers"),
    });
  }

  return { withCors, preflight };
}
