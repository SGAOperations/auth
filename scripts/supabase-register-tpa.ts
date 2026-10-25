// Registers SGAuth as a third-party auth provider on a product's Supabase
// project, through the Supabase Management API, then checks that Supabase
// resolved SGAuth's live signing keys. The dashboard has no generic provider
// option, so the API is the only way to do this. See
// docs/integration/supabase-products.md.
//
// This is product-integration tooling, not application code. It talks to the
// Management API about a product's project and adds no `@supabase/*`
// dependency, no app env var and nothing under `src/`. It reads `process.env`
// directly: the `src/lib/env.ts` rule in docs/ENGINEERING.md section 2 covers
// application code only.
//
// Run with Node 22.6 or later. Keep this file to erasable TypeScript (no enum,
// namespace or parameter properties) and free of relative imports, so Node can
// strip the types.
//
// Usage: SUPABASE_ACCESS_TOKEN=... node --experimental-strip-types scripts/supabase-register-tpa.ts \
//   --project-ref <ref> [--issuer <url>] [--mode oidc|jwks-url|custom-jwks] [--dry-run]
//
// Exit codes: 0 registered and verified (or --help, --dry-run), 1 bad input or
// API error, 2 not verified.
import { parseArgs } from "node:util";

const DEFAULT_ISSUER = "https://auth.northeasternsga.com";
const MODES = ["oidc", "jwks-url", "custom-jwks"] as const;
type Mode = (typeof MODES)[number];

const POLL_ATTEMPTS = 6;
const POLL_INTERVAL_MS = 5000;

const USAGE = `Usage: SUPABASE_ACCESS_TOKEN=... node --experimental-strip-types scripts/supabase-register-tpa.ts --project-ref <ref> [options]

Options:
  --project-ref <ref>   Supabase project ref (20 lowercase letters). Required.
  --issuer <url>        SGAuth origin. Default ${DEFAULT_ISSUER}.
                        Use https://auth-dev.northeasternsga.com for dev.
  --mode <mode>         oidc (default), jwks-url or custom-jwks.
  --dry-run             Print the request body and exit without any request.
  --help                Print this message.

Exit codes: 0 ok, 1 bad input or API error, 2 not verified.`;

class InputError extends Error {}

interface Jwk {
  kty?: unknown;
  crv?: unknown;
  kid?: unknown;
}

interface Integration {
  id: string;
  oidc_issuer_url: string | null;
  jwks_url: string | null;
  resolved_jwks: { keys: Jwk[] } | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asKeys(value: unknown): Jwk[] | null {
  if (!isRecord(value) || !Array.isArray(value.keys)) return null;
  return value.keys.filter(isRecord);
}

function asIntegration(value: unknown): Integration | null {
  if (!isRecord(value) || typeof value.id !== "string") return null;
  const keys = asKeys(value.resolved_jwks);
  return {
    id: value.id,
    oidc_issuer_url:
      typeof value.oidc_issuer_url === "string" ? value.oidc_issuer_url : null,
    jwks_url: typeof value.jwks_url === "string" ? value.jwks_url : null,
    resolved_jwks: keys === null ? null : { keys },
  };
}

function validateIssuer(raw: string): string {
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new InputError("--issuer is not a valid URL");
  }
  if (url.protocol !== "https:") {
    throw new InputError("--issuer must use https");
  }
  if (raw.endsWith("/") || url.pathname !== "/" || url.search || url.hash) {
    throw new InputError(
      "--issuer must be a bare origin with no path or trailing slash",
    );
  }
  return raw;
}

function parseInput(argv: string[]) {
  let values;
  try {
    ({ values } = parseArgs({
      args: argv,
      options: {
        "project-ref": { type: "string" },
        issuer: { type: "string" },
        mode: { type: "string" },
        "dry-run": { type: "boolean" },
        help: { type: "boolean" },
      },
      strict: true,
    }));
  } catch (error) {
    throw new InputError(
      error instanceof Error ? error.message : "invalid arguments",
    );
  }
  if (values.help) return { help: true as const };

  const token = process.env.SUPABASE_ACCESS_TOKEN;
  if (!token) throw new InputError("SUPABASE_ACCESS_TOKEN is not set");

  const projectRef = values["project-ref"];
  if (projectRef === undefined || !/^[a-z]{20}$/.test(projectRef)) {
    throw new InputError(
      "--project-ref is required and must be 20 lowercase letters",
    );
  }

  const mode = values.mode ?? "oidc";
  if (!(MODES as readonly string[]).includes(mode)) {
    throw new InputError("--mode must be oidc, jwks-url or custom-jwks");
  }

  return {
    help: false as const,
    token,
    projectRef,
    issuer: validateIssuer(values.issuer ?? DEFAULT_ISSUER),
    mode: mode as Mode,
    dryRun: values["dry-run"] === true,
  };
}

async function fetchJson(
  url: string,
  init?: RequestInit,
): Promise<{ ok: boolean; status: number; body: unknown }> {
  const response = await fetch(url, init);
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    // A non-JSON body is reported by status alone.
  }
  return { ok: response.ok, status: response.status, body };
}

class ApiError extends Error {}

function apiFailure(
  action: string,
  result: { status: number; body: unknown },
): ApiError {
  const message =
    isRecord(result.body) && typeof result.body.message === "string"
      ? result.body.message
      : "no message";
  return new ApiError(`${action} failed: ${result.status} ${message}`);
}

async function fetchLiveJwks(issuer: string): Promise<Jwk[]> {
  const result = await fetchJson(`${issuer}/.well-known/jwks.json`);
  const keys = result.ok ? asKeys(result.body) : null;
  if (keys === null) {
    throw new ApiError(`Could not read ${issuer}/.well-known/jwks.json`);
  }
  return keys;
}

async function requestBody(
  mode: Mode,
  issuer: string,
): Promise<Record<string, unknown>> {
  if (mode === "oidc") return { oidc_issuer_url: issuer };
  const jwksUrl = `${issuer}/.well-known/jwks.json`;
  if (mode === "jwks-url") return { jwks_url: jwksUrl };
  return { custom_jwks: { keys: await fetchLiveJwks(issuer) } };
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function kids(keys: Jwk[]): string[] {
  return keys.flatMap((key) => (typeof key.kid === "string" ? [key.kid] : []));
}

/** Returns the exit code. */
async function verify(
  base: string,
  headers: Record<string, string>,
  id: string,
  issuer: string,
): Promise<number> {
  let resolved: Jwk[] | null = null;
  for (let attempt = 0; attempt < POLL_ATTEMPTS; attempt++) {
    if (attempt > 0) await sleep(POLL_INTERVAL_MS);
    const result = await fetchJson(`${base}/${id}`, { headers });
    if (!result.ok) throw apiFailure("Reading the integration", result);
    resolved = asIntegration(result.body)?.resolved_jwks?.keys ?? null;
    if (resolved !== null) break;
  }
  if (resolved === null) {
    console.log(
      "Not resolved yet — re-run in a few minutes; if it never resolves, use --mode custom-jwks",
    );
    return 2;
  }

  const live = (await fetchLiveJwks(issuer)).filter(
    (key) => key.kty === "EC" && key.crv === "P-256",
  );
  const liveKids = kids(live);
  const resolvedKids = kids(resolved);
  const shared = liveKids.find((kid) => resolvedKids.includes(kid));
  if (shared === undefined) {
    console.log(`SGAuth kids: ${liveKids.join(", ") || "(none)"}`);
    console.log(`Supabase kids: ${resolvedKids.join(", ") || "(none)"}`);
    return 2;
  }
  console.log(`Verified: Supabase resolved kid ${shared}`);
  return 0;
}

async function main(): Promise<number> {
  const input = parseInput(process.argv.slice(2));
  if (input.help) {
    console.log(USAGE);
    return 0;
  }

  const body = await requestBody(input.mode, input.issuer);
  if (input.dryRun) {
    console.log(JSON.stringify(body, null, 2));
    return 0;
  }

  const base = `https://api.supabase.com/v1/projects/${input.projectRef}/config/auth/third-party-auth`;
  const headers = { Authorization: `Bearer ${input.token}` };

  const listed = await fetchJson(base, { headers });
  if (!listed.ok) throw apiFailure("Listing integrations", listed);
  const existing = (Array.isArray(listed.body) ? listed.body : [])
    .map(asIntegration)
    .find(
      (item) =>
        item !== null &&
        (("oidc_issuer_url" in body && item.oidc_issuer_url === input.issuer) ||
          ("jwks_url" in body && item.jwks_url === body.jwks_url)),
    );

  let id: string;
  if (existing) {
    id = existing.id;
    console.log(`Already registered: ${id}`);
  } else {
    const created = await fetchJson(base, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
    const integration = created.ok ? asIntegration(created.body) : null;
    if (integration === null) throw apiFailure("Registering", created);
    id = integration.id;
    console.log(`Registered: ${id}`);
  }

  return verify(base, headers, id, input.issuer);
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    const message = error instanceof Error ? error.message : "unknown error";
    console.error(message);
    process.exitCode = 1;
  },
);
