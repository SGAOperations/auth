import "server-only";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { nextCookies } from "better-auth/next-js";
import { prisma } from "@/lib/prisma";
import { parseAuthEnv } from "@/lib/auth/settings";
import { signupAllowlist } from "@/lib/auth/signup-allowlist-plugin";

// Single process.env read for auth until src/lib/env.ts (AUTH-T07) exists.
const settings = parseAuthEnv(process.env);

export const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  baseURL: settings.baseURL,
  secret: settings.secret,
  trustedOrigins: settings.trustedOrigins,
  advanced: { database: { generateId: false } },
  // nextCookies must stay the last plugin.
  plugins: [
    ...(settings.signupAllowlist
      ? [signupAllowlist(settings.signupAllowlist)]
      : []),
    nextCookies(),
  ],
});
