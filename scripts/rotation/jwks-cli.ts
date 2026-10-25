import { z } from "zod";
import type { SecretConfig } from "better-auth/crypto";
import { UsageError } from "../../prisma/seed/sync-env.js";
import {
  SGAUTH_ENVS,
  parseVersionedSecrets,
  type VersionedSecret,
} from "../../src/lib/env-schema.js";
import { parseIssuer } from "./supabase-tpa.js";

// Pure parsing for scripts/jwks-rotate.ts: no I/O and no `server-only` imports.

export const ROTATE_COMMANDS = [
  "status",
  "stage",
  "activate",
  "retire",
] as const;

export type RotateCommand = (typeof ROTATE_COMMANDS)[number];

export interface RotateArgs {
  command: RotateCommand;
  apply: boolean;
  /** `activate` only: the origin whose public JWKS must already serve the key. */
  issuer?: string;
  /** `retire` only: the id of the key to delete. */
  kid?: string;
}

export function parseRotateArgs(argv: string[]): RotateArgs {
  let command: string | undefined;
  let apply = false;
  let issuer: string | undefined;
  let kid: string | undefined;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--issuer" || arg === "--kid") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      if (arg === "--issuer") issuer = parseIssuer(value);
      else kid = value;
    } else if (arg.startsWith("--") || command !== undefined) {
      throw new UsageError(`Unknown argument: ${arg}`);
    } else {
      command = arg;
    }
  }

  const name = command ?? "status";
  if (!(ROTATE_COMMANDS as readonly string[]).includes(name)) {
    throw new UsageError(`Unknown command: ${name}`);
  }
  const resolved = name as RotateCommand;

  if (resolved === "activate" && issuer === undefined) {
    throw new UsageError("activate needs --issuer <https-origin>");
  }
  if (resolved === "retire" && kid === undefined) {
    throw new UsageError("retire needs --kid <key id>");
  }
  if (issuer !== undefined && resolved !== "activate") {
    throw new UsageError("--issuer applies to activate only");
  }
  if (kid !== undefined && resolved !== "retire") {
    throw new UsageError("--kid applies to retire only");
  }
  return { command: resolved, apply, issuer, kid };
}

const rotateEnvSchema = z.object({
  DIRECT_URL: z
    .string()
    .min(1)
    .refine((value) => URL.canParse(value)),
  SGAUTH_ENV: z.enum(SGAUTH_ENVS),
  BETTER_AUTH_SECRET: z.string().min(32),
  BETTER_AUTH_SECRETS: z.string().optional(),
});

/**
 * Mirrors the shape Better Auth builds from `secrets` plus the legacy secret:
 * encryption uses the current version, decryption any listed version or, for
 * bare ciphertext, the legacy secret. Without versions it is the plain secret.
 */
export function buildSecretConfig(
  secret: string,
  secrets: VersionedSecret[] | undefined,
): string | SecretConfig {
  if (!secrets) return secret;
  return {
    keys: new Map(secrets.map((entry) => [entry.version, entry.value])),
    currentVersion: secrets[0].version,
    legacySecret: secret,
  };
}

export interface RotateEnv {
  directUrl: string;
  sgauthEnv: (typeof SGAUTH_ENVS)[number];
  secret: string | SecretConfig;
}

// Names only: DIRECT_URL carries the migration role's password and the secrets
// decrypt every signing key.
export function parseRotateEnv(
  raw: Record<string, string | undefined>,
): RotateEnv {
  const parsed = rotateEnvSchema.safeParse({
    ...raw,
    BETTER_AUTH_SECRETS: raw.BETTER_AUTH_SECRETS || undefined,
  });
  if (!parsed.success) {
    const names = [
      ...new Set(parsed.error.issues.map((issue) => issue.path.join("."))),
    ];
    throw new UsageError(
      `Invalid environment (DIRECT_URL, SGAUTH_ENV and BETTER_AUTH_SECRET of at least 32 characters are required). Problem with: ${names.join(", ")}`,
    );
  }
  const env = parsed.data;

  let secrets: VersionedSecret[] | undefined;
  if (env.BETTER_AUTH_SECRETS !== undefined) {
    try {
      secrets = parseVersionedSecrets(env.BETTER_AUTH_SECRETS);
    } catch (error) {
      throw new UsageError(
        `Invalid environment. BETTER_AUTH_SECRETS: ${(error as Error).message}`,
      );
    }
  }
  return {
    directUrl: env.DIRECT_URL,
    sgauthEnv: env.SGAUTH_ENV,
    secret: buildSecretConfig(env.BETTER_AUTH_SECRET, secrets),
  };
}
