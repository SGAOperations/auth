import { z } from "zod";

// Pure on purpose: no `server-only`, no `@/` imports and no `process.env`, so
// it loads in Next, in Vitest and through prisma/seed.ts in plain Node.

export const SGAUTH_ENVS = ["production", "dev", "preview", "local"] as const;

export type SgauthEnv = (typeof SGAUTH_ENVS)[number];

export const CSP_MODES = ["report-only", "enforce"] as const;

export type CspMode = (typeof CSP_MODES)[number];

const postgresUrl = z
  .url()
  .refine(
    (value) => /^postgres(ql)?:\/\//.test(value),
    "must use the postgres:// or postgresql:// scheme",
  );

export const serverShape = z.object({
  SGAUTH_ENV: z.enum(SGAUTH_ENVS),
  NODE_ENV: z
    .enum(["development", "test", "production"])
    .default("development"),
  DATABASE_URL: postgresUrl,
  BETTER_AUTH_SECRET: z.string().min(32),
  LOG_LEVEL: z.enum(["debug", "info", "warn", "error", "silent"]).optional(),
  VERCEL_ENV: z.string().optional(),
  VERCEL_BRANCH_URL: z.string().optional(),
  VERCEL_URL: z.string().optional(),
  SGAUTH_SIGNUP_ALLOWLIST: z.string().optional(),
  SGAUTH_PREVIEW_GATE_PASSWORD: z.string().min(16).optional(),
  SGAUTH_PREVIEW_GATE: z.enum(["on", "off"]).optional(),
  SGAUTH_CSP_MODE: z.enum(CSP_MODES).default("report-only"),
  RESEND_API_KEY: z.string().optional(),
  RESEND_FROM_EMAIL: z.email().optional(),
  UPSTASH_REDIS_REST_URL: z.url().optional(),
  UPSTASH_REDIS_REST_TOKEN: z.string().optional(),
  POSTHOG_KEY: z.string().optional(),
  POSTHOG_HOST: z.url().optional(),
  CRON_SECRET: z.string().min(32).optional(),
  SEED_PRIMARY_ADMIN_EMAIL: z
    .string()
    .trim()
    .toLowerCase()
    .pipe(z.email())
    .optional(),
  SEED_PRIMARY_ADMIN_PASSWORD: z.string().min(12).max(128).optional(),
  SEED_PRIMARY_ADMIN_NAME: z.string().trim().min(1).max(100).optional(),
});

// Picked from the unrefined shape: zod refuses `.pick()` on refined objects.
export const authEnvSchema = serverShape.pick({
  SGAUTH_ENV: true,
  BETTER_AUTH_SECRET: true,
  VERCEL_ENV: true,
  VERCEL_BRANCH_URL: true,
  VERCEL_URL: true,
  SGAUTH_SIGNUP_ALLOWLIST: true,
  SGAUTH_PREVIEW_GATE_PASSWORD: true,
  SGAUTH_PREVIEW_GATE: true,
});

// A service is configured completely or not at all. Consumer tickets that
// need a service make its keys required.
const SERVICE_GROUPS = [
  ["RESEND_API_KEY", "RESEND_FROM_EMAIL"],
  ["UPSTASH_REDIS_REST_URL", "UPSTASH_REDIS_REST_TOKEN"],
  ["POSTHOG_KEY", "POSTHOG_HOST"],
  // Not a service: the local seed's Primary Admin credentials.
  ["SEED_PRIMARY_ADMIN_EMAIL", "SEED_PRIMARY_ADMIN_PASSWORD"],
] as const;

// A seed password must never sit in the env of a deployed or shared app.
const LOCAL_ONLY_KEYS = [
  "SEED_PRIMARY_ADMIN_EMAIL",
  "SEED_PRIMARY_ADMIN_PASSWORD",
  "SEED_PRIMARY_ADMIN_NAME",
] as const;

export const serverSchema = serverShape.superRefine((env, ctx) => {
  if (env.SGAUTH_ENV !== "local") {
    for (const key of LOCAL_ONLY_KEYS) {
      if (env[key] !== undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: "only allowed when SGAUTH_ENV=local",
        });
      }
    }
  }

  for (const group of SERVICE_GROUPS) {
    const isSet = group.some((key) => env[key] !== undefined);
    if (!isSet) continue;
    for (const key of group) {
      if (env[key] === undefined) {
        ctx.addIssue({
          code: "custom",
          path: [key],
          message: `required when ${group.filter((other) => other !== key).join(", ")} is set`,
        });
      }
    }
  }
});

export type ServerEnv = z.infer<typeof serverSchema>;

// No NEXT_PUBLIC_* variable exists yet.
export const publicSchema = z.object({});

export type PublicEnv = z.infer<typeof publicSchema>;

type RawEnv = Record<string, string | undefined>;

/**
 * Copies only the declared keys, so undeclared variables never reach a
 * result, and maps `""` to `undefined`, so `KEY=` counts as missing.
 */
export function normalizeEnv(raw: RawEnv, keys: readonly string[]): RawEnv {
  const normalized: RawEnv = {};
  for (const key of keys) {
    normalized[key] = raw[key] === "" ? undefined : raw[key];
  }
  return normalized;
}

function parseWith<T extends z.ZodType>(
  schema: T,
  keys: readonly string[],
  raw: RawEnv,
  label: string,
): z.infer<T> {
  const normalized = normalizeEnv(raw, keys);
  const result = schema.safeParse(normalized);
  if (result.success) return result.data;

  // Lines carry the variable name and the reason only, never an input value.
  const lines = result.error.issues.map((issue) => {
    const key = issue.path.join(".");
    return normalized[key] === undefined
      ? `  - ${key}: missing`
      : `  - ${key || label}: ${issue.message}`;
  });
  const sgauthEnv = SGAUTH_ENVS.find(
    (value) => value === normalized.SGAUTH_ENV,
  );
  const header = sgauthEnv
    ? `Invalid ${label} environment (SGAUTH_ENV=${sgauthEnv}):`
    : `Invalid ${label} environment (SGAUTH_ENV unset or invalid):`;
  throw new Error(
    [header, ...lines, "See .env.example for every variable."].join("\n"),
  );
}

export function parseServerEnv(raw: RawEnv): ServerEnv {
  return parseWith(serverSchema, Object.keys(serverShape.shape), raw, "server");
}

export function parsePublicEnv(raw: RawEnv): PublicEnv {
  return parseWith(
    publicSchema,
    Object.keys(publicSchema.shape),
    raw,
    "public",
  );
}
