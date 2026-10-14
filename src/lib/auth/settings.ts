import "server-only";
import { z } from "zod";
import {
  parseSignupAllowlist,
  type SignupAllowlist,
} from "@/lib/auth/signup-allowlist";

const SGAUTH_ENVS = ["production", "dev", "preview", "local"] as const;

export type SgauthEnv = (typeof SGAUTH_ENVS)[number];

export const authEnvSchema = z.object({
  SGAUTH_ENV: z.enum(SGAUTH_ENVS),
  BETTER_AUTH_SECRET: z.string().min(32),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
  SGAUTH_SIGNUP_ALLOWLIST: z.string().optional(),
  SGAUTH_PREVIEW_GATE_PASSWORD: z.string().min(16).optional(),
  SGAUTH_PREVIEW_GATE: z.enum(["on", "off"]).optional(),
});

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

// `.env.example` ships the optional gate variables as empty strings, which
// mean "unset".
function withoutEmptyGateVars(raw: Record<string, string | undefined>) {
  const cleaned = { ...raw };
  for (const key of [
    "SGAUTH_SIGNUP_ALLOWLIST",
    "SGAUTH_PREVIEW_GATE_PASSWORD",
    "SGAUTH_PREVIEW_GATE",
  ]) {
    if (cleaned[key] === "") delete cleaned[key];
  }
  return cleaned;
}

export function parseAuthEnv(raw: Record<string, string | undefined>) {
  const result = authEnvSchema.safeParse(withoutEmptyGateVars(raw));
  if (!result.success) {
    throw invalidEnv(
      result.error.issues.map(
        (issue) => `- ${issue.path.join(".")}: ${issue.message}`,
      ),
    );
  }
  const env = result.data;
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
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    // AUTH-T56 replaces with the product registry
    trustedOrigins: [baseURL],
    signupAllowlist,
    previewGate,
  };
}
