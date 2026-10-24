// Pure Origin enforcement for state-changing /api/sgauth/* requests. No env,
// no Prisma, no `@/` imports, like csp.ts and cors.ts; src/proxy.ts wires it to
// the product registry. Contract: docs/SESSION-COOKIE.md, "Origin enforcement".

export const SAFE_METHODS: ReadonlySet<string> = new Set([
  "GET",
  "HEAD",
  "OPTIONS",
]);

export const ORIGIN_ENFORCED_PREFIX = "/api/sgauth";

const MAX_LOGGED_ORIGIN_LENGTH = 200;

export type OriginRejection =
  | "cross_site"
  | "missing_origin"
  | "null_origin"
  | "malformed_origin"
  | "untrusted_origin"
  | "registry_error";

export type OriginVerdict = { ok: true } | { ok: false; reason: OriginRejection };

export function isOriginEnforcedPath(pathname: string): boolean {
  return (
    pathname === ORIGIN_ENFORCED_PREFIX ||
    pathname.startsWith(`${ORIGIN_ENFORCED_PREFIX}/`)
  );
}

// The origin of an http(s) URL, or null. An Origin header must be a bare
// origin; a Referer is reduced to its origin because its path is not trusted.
function parseOrigin(value: string, bare: boolean): string | null {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (bare) {
    const hasExtras =
      url.pathname !== "/" ||
      url.search !== "" ||
      url.hash !== "" ||
      url.username !== "" ||
      url.password !== "";
    if (hasExtras) return null;
  }
  return url.origin;
}

function normalizeTrusted(trustedOrigins: readonly string[]): Set<string> {
  const set = new Set<string>();
  for (const entry of trustedOrigins) {
    try {
      set.add(new URL(entry).origin);
    } catch {
      // An unparseable registry entry can never match a request.
    }
  }
  return set;
}

/** The header the verdict is based on, for logging: raw Origin, or the Referer's origin. */
function claimedOrigin(headers: Headers): string | null {
  const origin = headers.get("Origin");
  if (origin !== null) return origin;
  const referer = headers.get("Referer");
  if (referer === null) return null;
  return parseOrigin(referer, false);
}

export function checkOrigin(input: {
  method: string;
  headers: Headers;
  trustedOrigins: readonly string[];
}): OriginVerdict {
  const { method, headers, trustedOrigins } = input;
  if (SAFE_METHODS.has(method.toUpperCase())) return { ok: true };

  // Every registered product is same-site with SGAuth, so cross-site is never
  // legitimate. Sibling subdomains are `same-site`; only Origin tells them apart.
  if (headers.get("Sec-Fetch-Site") === "cross-site") {
    return { ok: false, reason: "cross_site" };
  }

  const originHeader = headers.get("Origin");
  if (originHeader === "null") return { ok: false, reason: "null_origin" };

  let origin: string | null;
  if (originHeader !== null) {
    origin = parseOrigin(originHeader, true);
  } else {
    const referer = headers.get("Referer");
    if (referer === null) return { ok: false, reason: "missing_origin" };
    origin = parseOrigin(referer, false);
  }
  if (origin === null) return { ok: false, reason: "malformed_origin" };

  // Exact match only: never a wildcard or a pattern.
  return normalizeTrusted(trustedOrigins).has(origin)
    ? { ok: true }
    : { ok: false, reason: "untrusted_origin" };
}

/** Uniform for every reason, so it is no oracle for which origins are registered. */
export function invalidOriginResponse(): Response {
  return Response.json(
    { code: "INVALID_ORIGIN", message: "Invalid origin." },
    { status: 403, headers: { "Cache-Control": "no-store" } },
  );
}

export interface OriginGuardDeps {
  trustedOrigins: (request: Request) => Promise<readonly string[]>;
  log: {
    warn: (msg: string, fields?: Record<string, unknown>) => void;
    error: (msg: string, fields?: Record<string, unknown>) => void;
  };
}

/** A response that stops the request, or null to let it through. Never throws. */
export function createOriginGuard({ trustedOrigins, log }: OriginGuardDeps) {
  return async function guardOrigin(request: Request): Promise<Response | null> {
    if (SAFE_METHODS.has(request.method.toUpperCase())) return null;
    const { pathname } = new URL(request.url);
    if (!isOriginEnforcedPath(pathname)) return null;

    let verdict: OriginVerdict;
    try {
      verdict = checkOrigin({
        method: request.method,
        headers: request.headers,
        trustedOrigins: await trustedOrigins(request),
      });
    } catch (error) {
      log.error("Origin check could not load trusted origins", {
        errorName: error instanceof Error ? error.name : "unknown",
      });
      verdict = { ok: false, reason: "registry_error" };
    }
    if (verdict.ok) return null;

    // Never the Cookie header, the query string, or a full Referer.
    log.warn("Rejected cross-origin mutation", {
      reason: verdict.reason,
      method: request.method,
      path: pathname,
      origin: claimedOrigin(request.headers)?.slice(0, MAX_LOGGED_ORIGIN_LENGTH),
    });
    return invalidOriginResponse();
  };
}
