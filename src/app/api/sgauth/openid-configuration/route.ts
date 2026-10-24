import { NextResponse } from "next/server";
import { buildOpenIdConfiguration } from "@/lib/auth/jwt";
import { toAuthSettings } from "@/lib/auth/settings";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

// Served at /.well-known/openid-configuration (next.config.ts rewrites), so
// Supabase can be pointed at the issuer URL. Public and read-only.
async function handler() {
  const { baseURL } = toAuthSettings(env);
  return NextResponse.json(buildOpenIdConfiguration(baseURL), {
    headers: { "Cache-Control": "public, max-age=300" },
  });
}

export const GET = withRequestLogging(
  "/api/sgauth/openid-configuration",
  handler,
  logger,
);
