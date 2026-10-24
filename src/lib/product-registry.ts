import { PRODUCT_BASE_URL_RE } from "@/lib/product-input";
import type { SgauthEnv } from "@/lib/env-schema";

// Pure on purpose: no `server-only`, no database, env or secret. The loader,
// clock and logger are injected, so the cache and the origin rules are
// unit-testable. src/lib/products.ts wires the real ones.

export const PRODUCT_CACHE_TTL_MS = 60_000;
export const PRODUCT_FAILURE_TTL_MS = 5_000;
export const MAX_REDIRECT_LENGTH = 2048;

const LOCAL_DEV_ORIGIN_RE =
  /^http:\/\/([a-z0-9]([a-z0-9-]*[a-z0-9])?\.)+sga\.localhost(:\d{1,5})?$/;

// Same set the relative-redirect rule rejects: path escapes via %2f and %5c.
const ENCODED_SLASH_RE = /%2f|%5c/i;

// A placeholder origin that no registered product can have.
const RELATIVE_BASE = "https://redirect.invalid";

function hasWhitespaceOrControl(value: string): boolean {
  if (/\s/.test(value)) return true;
  for (const char of value) {
    const code = char.codePointAt(0) ?? 0;
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

/**
 * Canonical form of an http(s) origin: lower-case host, default port dropped,
 * path, query and fragment stripped, IDN hosts punycoded. Null for anything
 * with whitespace, control characters or credentials, and for other schemes.
 */
export function normalizeOrigin(value: string): string | null {
  if (hasWhitespaceOrControl(value) || !URL.canParse(value)) return null;
  const url = new URL(value);
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  if (url.username !== "" || url.password !== "") return null;
  return url.origin;
}

/**
 * True for `http://<name>.sga.localhost[:port]` in canonical form. `*.localhost`
 * resolves only to loopback, so trusting it is safe on a developer machine.
 * Bare `localhost` and `sga.localhost` itself are not accepted.
 */
export function isLocalDevOrigin(origin: string): boolean {
  return normalizeOrigin(origin) === origin && LOCAL_DEV_ORIGIN_RE.test(origin);
}

/** The Prisma `Product` fields the registry reads, declared structurally. */
export interface RegistryProductRow {
  slug: string;
  name: string;
  description: string;
  baseUrl: string;
  iconUrl: string | null;
  sortOrder: number;
  visibleToPositionKeys: string[];
  loginRedirectPath: string | null;
}

export type ActiveProduct = Readonly<RegistryProductRow>;

export interface RegistryLog {
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

export interface ProductRegistryDeps {
  loadActiveProducts: () => Promise<readonly RegistryProductRow[]>;
  /** SGAuth's own origin, trusted even when the registry is unreachable. */
  ownOrigin: string;
  sgauthEnv: SgauthEnv;
  log: RegistryLog;
  now?: () => number;
  ttlMs?: number;
  failureTtlMs?: number;
}

interface Snapshot {
  products: readonly ActiveProduct[];
  origins: ReadonlySet<string>;
  expiresAt: number;
}

function isSafeRelativeRedirect(url: string): boolean {
  if (!url.startsWith("/") || url.startsWith("//") || url.includes("\\")) {
    return false;
  }
  const path = url.split(/[?#]/, 1)[0] ?? "";
  if (ENCODED_SLASH_RE.test(path)) return false;
  return new URL(url, RELATIVE_BASE).origin === RELATIVE_BASE;
}

export function createProductRegistry({
  loadActiveProducts,
  ownOrigin,
  sgauthEnv,
  log,
  now = Date.now,
  ttlMs = PRODUCT_CACHE_TTL_MS,
  failureTtlMs = PRODUCT_FAILURE_TTL_MS,
}: ProductRegistryDeps) {
  let snapshot: Snapshot | null = null;
  let inflight: Promise<Snapshot> | null = null;
  // Bumped by invalidate(): a load that started earlier must not store.
  let generation = 0;

  function buildSnapshot(rows: readonly RegistryProductRow[]): Snapshot {
    const products: ActiveProduct[] = [];
    const origins = new Set<string>([ownOrigin]);
    for (const row of rows) {
      // Defence in depth behind the database CHECK: a vercel.app, wildcard,
      // http or pathful value never becomes trusted, even if the CHECK is lost.
      if (
        !PRODUCT_BASE_URL_RE.test(row.baseUrl) ||
        normalizeOrigin(row.baseUrl) !== row.baseUrl
      ) {
        log.warn(
          "Product registry row skipped: base URL is not a canonical northeasternsga.com origin",
          { slug: row.slug },
        );
        continue;
      }
      products.push(row);
      origins.add(row.baseUrl);
    }
    return { products, origins, expiresAt: now() + ttlMs };
  }

  function failureSnapshot(error: unknown): Snapshot {
    // Never the message: it can carry the connection string.
    log.error(
      "[ALERT] product registry unavailable; trusting SGAuth's own origin only",
      { errorName: error instanceof Error ? error.name : "UnknownError" },
    );
    return {
      products: [],
      origins: new Set([ownOrigin]),
      expiresAt: now() + failureTtlMs,
    };
  }

  function load(): Promise<Snapshot> {
    const startedAt = generation;
    const promise: Promise<Snapshot> = (async () => {
      let result: Snapshot;
      try {
        result = buildSnapshot(await loadActiveProducts());
      } catch (error) {
        result = failureSnapshot(error);
      }
      if (startedAt === generation) snapshot = result;
      return result;
    })().finally(() => {
      if (inflight === promise) inflight = null;
    });
    inflight = promise;
    return promise;
  }

  async function current(): Promise<Snapshot> {
    if (snapshot && now() < snapshot.expiresAt) return snapshot;
    return inflight ?? load();
  }

  function originOf(value: string | null): string | null {
    if (value === null) return null;
    const origin = normalizeOrigin(value);
    return origin !== null && isLocalDevOrigin(origin) ? origin : null;
  }

  return {
    /**
     * Canonical origins only, never patterns. Never throws. On `local`, an
     * `*.sga.localhost` Origin or Referer on the request is echoed back, so
     * any local product stub works with no list to maintain.
     */
    async getTrustedOrigins(request?: Request): Promise<string[]> {
      const { origins } = await current();
      const trusted = [...origins];
      if (sgauthEnv === "local" && request) {
        const referer = request.headers.get("referer");
        const candidates = [
          originOf(request.headers.get("origin")),
          originOf(referer),
        ];
        for (const origin of candidates) {
          if (origin !== null && !trusted.includes(origin)) {
            trusted.push(origin);
          }
        }
      }
      return trusted;
    },

    /**
     * Whether a post-login redirect target is safe: a same-site relative path,
     * SGAuth itself or an active product origin. Callers parse their input
     * first and choose their own fallback.
     */
    async isAllowedRedirect(url: string): Promise<boolean> {
      if (
        url === "" ||
        url.length > MAX_REDIRECT_LENGTH ||
        hasWhitespaceOrControl(url)
      ) {
        return false;
      }
      if (url.startsWith("/")) return isSafeRelativeRedirect(url);

      const origin = normalizeOrigin(url);
      if (origin === null) return false;
      const { origins } = await current();
      if (origins.has(origin)) return true;
      return sgauthEnv === "local" && isLocalDevOrigin(origin);
    },

    async getActiveProducts(): Promise<readonly ActiveProduct[]> {
      return (await current()).products;
    },

    invalidate(): void {
      generation += 1;
      snapshot = null;
      inflight = null;
    },
  };
}
