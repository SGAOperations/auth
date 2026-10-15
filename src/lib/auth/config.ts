import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";
import { env } from "@/lib/env";
import { buildAuthOptions } from "@/lib/auth/options";
import { logger, logLevel } from "@/lib/log";
import { toAuthSettings } from "@/lib/auth/settings";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";
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
  // Better Auth's own lines go through the structured, redacting logger.
  logger:
    logLevel === "silent"
      ? { disabled: true }
      : {
          level: logLevel,
          log: (level, message, ...args: unknown[]) =>
            logger[level](message, args.length > 0 ? { args } : undefined),
        },
  // No DB-backed limiter table (AUTH-T15); AUTH-T63 replaces this with Upstash and disables the built-in limiter.
  rateLimit: { storage: "memory" },
  // nextCookies must stay the last plugin.
  plugins: [
    ...(settings.signupAllowlist
      ? [signupAllowlist(settings.signupAllowlist)]
      : []),
    nextCookies(),
  ],
});
