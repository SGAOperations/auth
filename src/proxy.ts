import { NextResponse, type NextRequest } from "next/server";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import {
  GATE_COOKIE,
  GATE_PATH,
  deriveGateKey,
  isExemptPath,
  isGatePath,
  verifyGateCookie,
} from "@/lib/preview-gate";
import { REDIRECT_ENTRY_PATHS, captureRedirect } from "@/lib/redirect/cookie";
import { isCorsPreflight } from "@/lib/security/cors";
import {
  CSP_REPORT_GROUP,
  CSP_REPORT_PATH,
  buildCsp,
  cspHeaderName,
  generateNonce,
} from "@/lib/security/csp";
import {
  createOriginGuard,
  decodePathname,
  malformedPathResponse,
} from "@/lib/security/origin";
import { scannerResponse } from "@/lib/token-links/scanner";

// A bad environment throws at import, so every request fails closed.
const settings = toAuthSettings(env);
const key = settings.previewGate
  ? deriveGateKey(settings.secret, settings.previewGate.password)
  : null;
const ownOrigin = new URL(settings.baseURL).origin;

// Mutations on /api/sgauth/* come from SGAuth's own pages only (BT5). No
// product mutates /api/sgauth/* from a browser: its cross-origin calls are the
// session GETs and POST /api/auth/sign-out (docs/CORS.md), and Better Auth
// checks /api/auth/* against the full registry itself. Trusting every product
// origin here let XSS on any product drive the admin API.
const guardOrigin = createOriginGuard({
  trustedOrigins: async () => [ownOrigin],
  log: logger,
});

const HARDENING_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

// Returns a response that stops the request, or null to let it through.
function gate(request: NextRequest): NextResponse | null {
  if (key === null) return null;

  const { pathname, search } = request.nextUrl;
  if (isExemptPath(pathname) || isGatePath(pathname)) return null;
  // Browsers never send cookies on a preflight, and it returns no body.
  if (isCorsPreflight(request.method, pathname)) return null;

  const cookie = request.cookies.get(GATE_COOKIE)?.value;
  if (verifyGateCookie(key, cookie, Math.floor(Date.now() / 1000))) {
    return null;
  }

  const isPageRequest =
    (request.method === "GET" || request.method === "HEAD") &&
    !pathname.startsWith("/api/");
  if (isPageRequest) {
    const target = new URL(GATE_PATH, request.url);
    target.searchParams.set("next", `${pathname}${search}`);
    return NextResponse.redirect(target, {
      status: 307,
      headers: HARDENING_HEADERS,
    });
  }

  return NextResponse.json(
    { error: "preview_gate" },
    { status: 401, headers: HARDENING_HEADERS },
  );
}

// Pages get a per-request nonce so Next can tag its own scripts. Next reads
// the nonce from either CSP header name, so report-only mode still works.
function withCsp(request: NextRequest): NextResponse {
  const nonce = generateNonce();
  const csp = buildCsp({
    nonce,
    isDev: env.NODE_ENV === "development",
    reportUri: CSP_REPORT_PATH,
  });
  const headerName = cspHeaderName(env.SGAUTH_CSP_MODE);

  const requestHeaders = new Headers(request.headers);
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set(headerName, csp);

  const response = NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set(headerName, csp);
  response.headers.set(
    "Reporting-Endpoints",
    `${CSP_REPORT_GROUP}="${request.nextUrl.origin}${CSP_REPORT_PATH}"`,
  );
  return response;
}

export async function proxy(request: NextRequest) {
  const blocked = gate(request);
  if (blocked) return blocked;

  const { pathname } = request.nextUrl;

  // HEAD and scanner GETs on an emailed link get a static page, no CSP needed.
  const scanned = scannerResponse(
    request.method,
    pathname,
    request.headers.get("user-agent"),
  );
  if (scanned) return scanned;

  // Decoded before the /api test, or `/%61pi/...` would skip the guard (BT6).
  const decoded = decodePathname(pathname);
  if (decoded === null) return malformedPathResponse();
  if (decoded.startsWith("/api/")) {
    const rejected = await guardOrigin(request);
    if (rejected) return rejected;
    return NextResponse.next();
  }

  const response = withCsp(request);
  if (request.method === "GET" && REDIRECT_ENTRY_PATHS.includes(pathname)) {
    await captureRedirect(request, response, {
      secret: settings.secret,
      baseURL: settings.baseURL,
      sgauthOrigin: new URL(settings.baseURL).origin,
      allowHttpProducts: settings.sgauthEnv === "local",
    });
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|icon.svg|sgauth-logo.svg).*)"],
};
