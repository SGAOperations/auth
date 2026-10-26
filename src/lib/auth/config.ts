import "server-only";
import { betterAuth, type BetterAuthOptions } from "better-auth";
import { after } from "next/server";
import { analytics } from "@/lib/analytics";
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
  deviceCookieName,
} from "@/lib/auth/cookies";
import { mailer } from "@/lib/email/server";
import { setPasswordService } from "@/lib/set-password/server";

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
    // secrets[0] signs; secret only decrypts pre-rotation data
    secret: settings.legacySecret,
    secrets: settings.secrets,
    trustedOrigins: getTrustedOrigins,
    advanced,
    analytics,
    lockout: {
      mailer,
      deviceCookie: {
        name: deviceCookieName(settings.cookies),
        secure: settings.cookies.secure,
      },
      // `after` keeps the Vercel function alive until the task settles, so the
      // counter write, the lock and its emails finish after the response.
      defer: (task) => after(task),
    },
    logger,
    onPasswordlessSignUp: (user) =>
      setPasswordService.requestForUser(user, "sign_up"),
  }),
  // Better Auth's own lines go through the structured, redacting logger. An
  // error-level line that carries an Error is also sent to error tracking:
  // Better Auth turns most internal failures into a handled 500, so
  // `onRequestError` never sees them.
  logger:
    logLevel === "silent"
      ? { disabled: true }
      : {
          level: logLevel,
          log: (level, message, ...args: unknown[]) => {
            logger[level](message, args.length > 0 ? { args } : undefined);
            if (level !== "error") return;
            const err = args.find((arg) => arg instanceof Error);
            if (err)
              void analytics.captureError(
                err,
                { source: "better-auth" },
                { defer: true },
              );
          },
        },
  // Upstash limits in src/lib/rate-limit (AUTH-T63); the built-in limiter stays off (docs/ENGINEERING.md §3).
  rateLimit: { enabled: false },
  plugins: buildAuthPlugins({
    signupAllowlist: settings.signupAllowlist,
    prisma,
    issuer: settings.baseURL,
    secret: settings.secret,
    sgauthEnv: settings.sgauthEnv,
  }),
});
