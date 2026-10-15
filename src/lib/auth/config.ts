import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildAuthPlugins } from "@/lib/auth/plugins";
import { toAuthSettings } from "@/lib/auth/settings";
import {
  assertSecureCookieConfig,
  buildCookieOptions,
} from "@/lib/auth/cookies";

const settings = toAuthSettings(env);

const advanced: NonNullable<BetterAuthOptions["advanced"]> = {
  database: { generateId: false },
  ...buildCookieOptions(settings.cookies),
};

// Checks the exact object Better Auth receives, so it runs at boot and stops
// `next start` and the Vercel cold start on an insecure cookie setting.
assertSecureCookieConfig({
  sgauthEnv: settings.sgauthEnv,
  baseURL: settings.baseURL,
  vercelEnv: settings.vercelEnv,
  advanced,
});

export const auth = betterAuth({
  ...buildAuthOptions({
    prisma,
    baseURL: settings.baseURL,
    secret: settings.secret,
    trustedOrigins: settings.trustedOrigins,
    advanced,
  }),
  // No session_data cookie: revocation must be immediate. Mirrored in
  // cookies.test.ts.
  session: { cookieCache: { enabled: false } },
  // No DB-backed limiter table (AUTH-T15); AUTH-T63 replaces this with Upstash and disables the built-in limiter.
  rateLimit: { storage: "memory" },
  plugins: buildAuthPlugins(settings.signupAllowlist),
});
