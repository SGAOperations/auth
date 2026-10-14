import "server-only";
import { z } from "zod";

const SGAUTH_ENVS = ["production", "dev", "preview", "local"] as const;

export type SgauthEnv = (typeof SGAUTH_ENVS)[number];

export const authEnvSchema = z.object({
  SGAUTH_ENV: z.enum(SGAUTH_ENVS),
  BETTER_AUTH_SECRET: z.string().min(32),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
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

export function parseAuthEnv(raw: Record<string, string | undefined>) {
  const result = authEnvSchema.safeParse(raw);
  if (!result.success) {
    const lines = result.error.issues.map(
      (issue) => `- ${issue.path.join(".")}: ${issue.message}`,
    );
    throw new Error(`Invalid auth environment:\n${lines.join("\n")}`);
  }
  const env = result.data;
  const baseURL = resolveBaseURL({
    sgauthEnv: env.SGAUTH_ENV,
    vercelBranchUrl: env.VERCEL_BRANCH_URL,
    vercelUrl: env.VERCEL_URL,
  });
  return {
    sgauthEnv: env.SGAUTH_ENV,
    secret: env.BETTER_AUTH_SECRET,
    baseURL,
    // AUTH-T56 replaces with the product registry
    trustedOrigins: [baseURL],
  };
}
