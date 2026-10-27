import { z } from "zod";
import { UsageError } from "../../prisma/seed/sync-env.js";

// Pure logic behind scripts/supabase-push-jwks.ts: argument and JWKS
// validation, matching of Supabase third-party-auth integrations, and the push
// plan. No I/O and no `@/` or `server-only` imports, so Vitest and plain Node
// both load it.

export const DEFAULT_ISSUER = "https://auth.northeasternsga.com";

const PROJECT_REF = /^[a-z]{20}$/;

export const jwksUrlFor = (issuer: string) => `${issuer}/.well-known/jwks.json`;

/** An https origin with no path, query or trailing slash. */
export function parseIssuer(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new UsageError("--issuer must be a URL such as " + DEFAULT_ISSUER);
  }
  if (
    url.protocol !== "https:" ||
    url.pathname !== "/" ||
    url.search !== "" ||
    url.hash !== "" ||
    value.endsWith("/")
  ) {
    throw new UsageError(
      "--issuer must be an https origin with no path and no trailing slash",
    );
  }
  return url.origin;
}

export interface PushArgs {
  issuer: string;
  projectRefs: string[];
  apply: boolean;
  help: boolean;
}

export function parsePushArgs(argv: string[]): PushArgs {
  let issuer = DEFAULT_ISSUER;
  const projectRefs: string[] = [];
  let apply = false;
  let help = false;

  for (let index = 0; index < argv.length; index++) {
    const arg = argv[index];
    if (arg === "--apply") {
      apply = true;
    } else if (arg === "--help") {
      help = true;
    } else if (arg === "--issuer" || arg === "--project-ref") {
      const value = argv[++index];
      if (value === undefined || value.startsWith("--")) {
        throw new UsageError(`${arg} needs a value`);
      }
      if (arg === "--issuer") {
        issuer = parseIssuer(value);
      } else {
        if (!PROJECT_REF.test(value)) {
          throw new UsageError(
            "--project-ref must be a 20-letter Supabase project ref",
          );
        }
        if (!projectRefs.includes(value)) projectRefs.push(value);
      }
    } else {
      throw new UsageError(`Unknown argument: ${arg}`);
    }
  }

  if (!help && projectRefs.length === 0) {
    throw new UsageError("Pass --project-ref at least once");
  }
  return { issuer, projectRefs, apply, help };
}

/** Names only: the token must never appear in an error. */
export function parsePushEnv(env: Record<string, string | undefined>): {
  accessToken: string;
} {
  const token = env.SUPABASE_ACCESS_TOKEN;
  if (!token) {
    throw new UsageError("SUPABASE_ACCESS_TOKEN is required");
  }
  return { accessToken: token };
}

const publicKey = z.looseObject({
  kty: z.literal("EC"),
  crv: z.literal("P-256"),
  alg: z.literal("ES256"),
  kid: z.string().min(1),
  x: z.string().min(1),
  y: z.string().min(1),
  use: z.string().optional(),
});

export type PublicJwk = {
  kty: "EC";
  crv: "P-256";
  alg: "ES256";
  kid: string;
  x: string;
  y: string;
  use?: string;
};

/**
 * Validates a JWKS document and strips every key to its public members. A key
 * carrying `d` (private material) refuses the whole document.
 */
export function parsePublicJwks(json: unknown): { keys: PublicJwk[] } {
  const parsed = z
    .object({
      keys: z
        .array(
          // `d` is private material: its presence refuses the whole document.
          publicKey.refine((key) => !("d" in key)),
        )
        .min(1),
    })
    .safeParse(json);
  if (!parsed.success) {
    throw new Error(
      "The JWKS is invalid: it needs at least one ES256 P-256 key with kid, x and y and no private member",
    );
  }
  return {
    keys: parsed.data.keys.map(({ kty, crv, alg, kid, x, y, use }) => ({
      kty,
      crv,
      alg,
      kid,
      x,
      y,
      ...(use === undefined ? {} : { use }),
    })),
  };
}

/** Key ids of any JWKS-shaped value. Tolerant: anything else yields none. */
export function kidsOf(jwks: unknown): string[] {
  const parsed = z
    .object({ keys: z.array(z.looseObject({ kid: z.string() })) })
    .safeParse(jwks);
  return parsed.success ? parsed.data.keys.map((key) => key.kid) : [];
}

export const integrationSchema = z.looseObject({
  id: z.string(),
  oidc_issuer_url: z.string().nullish(),
  jwks_url: z.string().nullish(),
  custom_jwks: z.unknown().optional(),
  resolved_jwks: z.unknown().optional(),
});

export type Integration = z.infer<typeof integrationSchema>;

export interface IntegrationMatch {
  /** Fetched by Supabase from the issuer: nothing to push, only to verify. */
  issuerBound: Integration[];
  /** An inline key set that holds SGAuth keys: replaced on every push. */
  inlineSgauth: Integration[];
}

/**
 * Sorts a project's integrations. Everything else (another product's issuer, an
 * inline set with none of our keys) is ignored and never touched.
 */
export function matchIntegrations(
  list: Integration[],
  issuer: string,
  liveKids: readonly string[],
): IntegrationMatch {
  const live = new Set(liveKids);
  const match: IntegrationMatch = { issuerBound: [], inlineSgauth: [] };
  for (const integration of list) {
    if (
      integration.oidc_issuer_url === issuer ||
      integration.jwks_url === jwksUrlFor(issuer)
    ) {
      match.issuerBound.push(integration);
    } else if (
      integration.custom_jwks &&
      kidsOf(integration.custom_jwks).some((kid) => live.has(kid))
    ) {
      match.inlineSgauth.push(integration);
    }
  }
  return match;
}

export type ProjectPlan =
  | { kind: "error"; reason: string }
  | {
      kind: "ok";
      /** Create a new inline integration with the live key set. */
      push: boolean;
      /** Inline integrations to delete once the new one has resolved. */
      deleteAfterCreate: string[];
      /** Every SGAuth integration whose `resolved_jwks` must cover the keys. */
      verify: Integration[];
    };

export function planProject(match: IntegrationMatch): ProjectPlan {
  const verify = [...match.issuerBound, ...match.inlineSgauth];
  if (verify.length === 0) {
    return {
      kind: "error",
      reason: "not registered (run scripts/supabase-register-tpa.ts, #93)",
    };
  }
  return {
    kind: "ok",
    push: match.inlineSgauth.length > 0,
    deleteAfterCreate: match.inlineSgauth.map((integration) => integration.id),
    verify,
  };
}

/** True only when every live key id is present in `resolved_jwks`. */
export function resolvedCovers(
  resolvedJwks: unknown,
  liveKids: readonly string[],
): boolean {
  const resolved = new Set(kidsOf(resolvedJwks));
  return liveKids.length > 0 && liveKids.every((kid) => resolved.has(kid));
}
