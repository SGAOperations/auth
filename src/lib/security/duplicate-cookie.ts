// Pure duplicate-cookie refusal. No env, no Prisma, no `@/` imports, like
// origin.ts; duplicate-cookie-server.ts wires it to the cookie name and the
// logger. Contract: docs/SESSION-COOKIE.md, "Duplicate session cookies".

/**
 * The paths on the Better Auth route that resolve "who is this cookie". Only
 * these two are guarded: they are the reads products and the stub forward
 * cookies to. Mutating endpoints stay unguarded, because refusing sign-out
 * could stop a victim from signing out.
 */
export const DUPLICATE_COOKIE_GUARDED_PATHS: ReadonlySet<string> = new Set([
  "/api/auth/get-session",
  "/api/auth/token",
]);

function pairName(pair: string): string | null {
  const separator = pair.indexOf("=");
  return separator === -1 ? null : pair.slice(0, separator).trim();
}

/**
 * How many `name=value` pairs in a Cookie header carry exactly `name`. The name
 * is trimmed and compared case-sensitively without decoding, the same key rule
 * Better Auth's cookie parser applies. Every copy counts, an empty value
 * included.
 */
export function countCookie(header: string | null, name: string): number {
  if (!header) return 0;
  let copies = 0;
  for (const pair of header.split(";")) {
    if (pairName(pair) === name) copies += 1;
  }
  return copies;
}

/** The header's other pairs, rejoined with `"; "`, or `""` when none are left. */
export function withoutCookie(header: string, name: string): string {
  return header
    .split(";")
    .filter((pair) => pairName(pair) !== name)
    .map((pair) => pair.trim())
    .filter((pair) => pair !== "")
    .join("; ");
}

interface DuplicateCookieGuardDeps {
  cookieName: string;
  paths: ReadonlySet<string>;
  log: { warn: (msg: string, fields?: Record<string, unknown>) => void };
}

/**
 * Wraps a route handler. A request carrying two or more copies of the session
 * cookie reaches the handler with every copy removed, so it gets the handler's
 * own signed-out answer. The log line carries the path and the copy count,
 * never the header, a value or the query string.
 */
export function createDuplicateCookieGuard({
  cookieName,
  paths,
  log,
}: DuplicateCookieGuardDeps) {
  return function withDuplicateCookieGuard(
    handler: (request: Request) => Promise<Response>,
  ): (request: Request) => Promise<Response> {
    return (request) => {
      let path = new URL(request.url).pathname;
      if (path.length > 1 && path.endsWith("/")) path = path.slice(0, -1);
      if (!paths.has(path)) return handler(request);

      const header = request.headers.get("cookie");
      const copies = countCookie(header, cookieName);
      if (header === null || copies < 2) return handler(request);

      log.warn("Refused duplicate session cookie", { path, copies });
      const headers = new Headers(request.headers);
      const remaining = withoutCookie(header, cookieName);
      if (remaining === "") headers.delete("cookie");
      else headers.set("cookie", remaining);
      return handler(new Request(request, { headers }));
    };
  };
}
