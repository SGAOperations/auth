import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildAuthPlugins } from "@/lib/auth/plugins";
import { logger, logLevel } from "@/lib/log";
import { getTrustedOrigins } from "@/lib/products";
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
    trustedOrigins: getTrustedOrigins,
    advanced,
  }),
  // Better Auth's own lines go through the structured, redacting logger.
  logger:
    logLevel === "silent"
      ? { disabled: true }
      : {
          level: logLevel,
          log: (level, message, ...args: unknown[]) =>
            logger[level](message, args.length > 0 ? { args } : undefined),
        },
  // No session_data cookie: revocation must be immediate. Mirrored in
  // cookies.test.ts.
  session: { cookieCache: { enabled: false } },
  // Upstash limits in src/lib/rate-limit (AUTH-T63); the built-in limiter stays off (docs/ENGINEERING.md §3).
  rateLimit: { enabled: false },
  plugins: buildAuthPlugins(settings.signupAllowlist),
});
