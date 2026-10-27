import { auth } from "@/lib/auth/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

// Served at /.well-known/jwks.json (next.config.ts rewrites), so Supabase can
// read the key set from the issuer URL. Better Auth routes by the request URL,
// and a rewrite leaves that URL at /.well-known/jwks.json, which its catch-all
// does not match. So this route hands the auth handler the path it expects.
async function handler(request: Request) {
  const url = new URL("/api/auth/jwks", request.url);
  return auth.handler(
    new Request(url, { method: "GET", headers: request.headers }),
  );
}

export const GET = withRequestLogging("/api/sgauth/jwks", handler, logger);
