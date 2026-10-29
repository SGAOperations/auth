import { createSgaProxy } from "@nusgaops/sgauth/proxy";
import { NextRequest } from "next/server";

// Reads the cookie name from SGAUTH_COOKIE_NAME, which the Playwright config
// sets. It never calls SGAuth: requireSession() is the boundary.
const sgaProxy = createSgaProxy({ publicPaths: ["/"] });

// `next start` builds `req.nextUrl` from the bind hostname, so the proxy would
// send the browser back to `http://localhost:300x/...`, not the host it asked
// for. The SDK takes the return URL from `nextUrl.href`, so rebuild the request
// on the Host header, as a deployed product behind its own domain sees it.
export default function proxy(req: NextRequest) {
  const host = req.headers.get("host");
  if (host === null) return sgaProxy(req);
  const { pathname, search } = req.nextUrl;
  return sgaProxy(
    new NextRequest(new URL(`${pathname}${search}`, `http://${host}`), {
      headers: req.headers,
      method: req.method,
    }),
  );
}

export const config = {
  matcher: ["/((?!_next/).*)"],
};
