import { NextResponse, type NextRequest } from "next/server";
import { parseAuthEnv } from "@/lib/auth/settings";
import {
  GATE_COOKIE,
  GATE_PATH,
  deriveGateKey,
  isExemptPath,
  isGatePath,
  verifyGateCookie,
} from "@/lib/preview-gate";

// A bad environment throws at import, so every request fails closed.
const settings = parseAuthEnv(process.env);
const key = settings.previewGate
  ? deriveGateKey(settings.secret, settings.previewGate.password)
  : null;

const HARDENING_HEADERS = {
  "Cache-Control": "no-store",
  "X-Robots-Tag": "noindex",
};

export function proxy(request: NextRequest) {
  if (key === null) return NextResponse.next();

  const { pathname, search } = request.nextUrl;
  if (isExemptPath(pathname) || isGatePath(pathname)) {
    return NextResponse.next();
  }

  const cookie = request.cookies.get(GATE_COOKIE)?.value;
  if (verifyGateCookie(key, cookie, Math.floor(Date.now() / 1000))) {
    return NextResponse.next();
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

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
