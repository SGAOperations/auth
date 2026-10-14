import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";
import { parseAuthEnv } from "@/lib/auth/settings";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";
import { buildCookieOptions, resolveCookiePolicy } from "@/lib/auth/cookies";

// Single process.env read for auth until src/lib/env.ts (AUTH-T07) exists.
const settings = parseAuthEnv(process.env);

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  baseURL: settings.baseURL,
  secret: settings.secret,
  trustedOrigins: settings.trustedOrigins,
  advanced: {
    database: { generateId: false },
    ...buildCookieOptions(resolveCookiePolicy(settings.sgauthEnv)),
  },
  // No session_data cookie: every request hits the DB, so revocation is
  // immediate (#38). #39 adds expiresIn/updateAge here. Mirrored in
  // cookies.test.ts.
  session: { cookieCache: { enabled: false } },
  // nextCookies must stay the last plugin.
  plugins: [
    ...(settings.signupAllowlist
      ? [signupAllowlist(settings.signupAllowlist)]
      : []),
    nextCookies(),
  ],
});
