import "server-only";
import { z } from "zod";
import { resolveCookiePolicy } from "@/lib/auth/cookies";
import {
  parseSignupAllowlist,
  type SignupAllowlist,
} from "@/lib/auth/signup-allowlist";
import { authEnvSchema, normalizeEnv, type SgauthEnv } from "@/lib/env-schema";

export type { SgauthEnv };

interface BaseURLInput {
  sgauthEnv: SgauthEnv;
  vercelBranchUrl?: string;
  vercelUrl?: string;
}

/**
 * Switches on `sgauthEnv` before touching any Vercel field, so production,
 * dev and local never read them: the cookie domain must stay the parent
 * domain, never a per-deployment hostname.
 */
export function resolveBaseURL(input: BaseURLInput): string {
  switch (input.sgauthEnv) {
    case "production":
      return "https://auth.northeasternsga.com";
    case "dev":
      return "https://auth-dev.northeasternsga.com";
    case "local":
      return "http://auth.sga.localhost:3000";
    case "preview": {
      const host = input.vercelBranchUrl ?? input.vercelUrl;
      if (!host) {
        throw new Error(
          "Preview environments need VERCEL_BRANCH_URL or VERCEL_URL",
        );
      }
      return `https://${host}`;
    }
  }
}

function invalidEnv(lines: string[]): Error {
  return new Error(`Invalid auth environment:\n${lines.join("\n")}`);
}

// `.env.example` ships the optional variables as empty strings, which mean
// "unset"; normalizeEnv maps them to undefined.
export function parseAuthEnv(raw: Record<string, string | undefined>) {
  const result = authEnvSchema.safeParse(
    normalizeEnv(raw, Object.keys(authEnvSchema.shape)),
  );
  if (!result.success) {
    throw invalidEnv(
      result.error.issues.map(
        (issue) => `- ${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  return toAuthSettings(result.data);
}

export function toAuthSettings(env: z.infer<typeof authEnvSchema>) {
  const baseURL = resolveBaseURL({
    sgauthEnv: env.SGAUTH_ENV,
    vercelBranchUrl: env.VERCEL_BRANCH_URL,
    vercelUrl: env.VERCEL_URL,
  });

  let signupAllowlist: SignupAllowlist | null = null;
  if (env.SGAUTH_ENV !== "production") {
    try {
      signupAllowlist = parseSignupAllowlist(env.SGAUTH_SIGNUP_ALLOWLIST);
    } catch (error) {
      throw invalidEnv([`- ${(error as Error).message}`]);
    }
  }

  let previewGate: { password: string } | null = null;
  const gatedEnv = env.SGAUTH_ENV === "dev" || env.SGAUTH_ENV === "preview";
  if (gatedEnv && env.SGAUTH_PREVIEW_GATE !== "off") {
    if (!env.SGAUTH_PREVIEW_GATE_PASSWORD) {
      throw invalidEnv([
        "- SGAUTH_PREVIEW_GATE_PASSWORD: required when SGAUTH_ENV is dev or preview (set SGAUTH_PREVIEW_GATE=off to disable the gate explicitly)",
      ]);
    }
    previewGate = { password: env.SGAUTH_PREVIEW_GATE_PASSWORD };
  }

  return {
    sgauthEnv: env.SGAUTH_ENV,
    vercelEnv: env.VERCEL_ENV,
    cookies: resolveCookiePolicy(env.SGAUTH_ENV),
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    signupAllowlist,
    previewGate,
  };
}
