import "server-only";
import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const GATE_COOKIE = "__Host-sgauth.preview-gate";
export const GATE_MAX_AGE = 604800;
export const GATE_PATH = "/preview-gate";
export const UNLOCK_PATH = "/preview-gate/unlock";

const CLOCK_SKEW_SECONDS = 60;

// Machine endpoints that product servers call server-to-server. Exact paths
// only: a prefix match would expose everything beneath them.
const EXEMPT_PATHS = new Set([
  "/api/auth/ok",
  "/api/auth/jwks",
  "/api/auth/token",
  "/api/auth/get-session",
  "/api/sgauth/session",
  "/api/sgauth/session/minimal",
  "/api/health",
  "/api/csp-report",
  // Bearer-protected by CRON_SECRET, which replaces the gate cookie.
  "/api/jobs/pa-transfer",
  "/api/jobs/alerts",
  "/api/jobs/retention",
  // Bearer-protected by APLIO_DUAL_WRITE_SECRET, called by Aplio's server.
  "/api/provision/aplio/users",
  // Bearer-protected by a product API key (#312), called by products' servers.
  "/api/products/slack/link-tokens",
  "/api/products/slack/lookup",
  "/.well-known/jwks.json",
  "/.well-known/openid-configuration",
]);

export function nowSeconds(): number {
  return Math.floor(Date.now() / 1000);
}

function stripTrailingSlash(pathname: string): string {
  return pathname.length > 1 && pathname.endsWith("/")
    ? pathname.slice(0, -1)
    : pathname;
}

export function isExemptPath(pathname: string): boolean {
  return EXEMPT_PATHS.has(stripTrailingSlash(pathname));
}

export function isGatePath(pathname: string): boolean {
  const path = stripTrailingSlash(pathname);
  return path === GATE_PATH || path === UNLOCK_PATH;
}

function hmac(key: Buffer | string, message: string): Buffer {
  return createHmac("sha256", key).update(message).digest();
}

export function deriveGateKey(secret: string, password: string): Buffer {
  return hmac(secret, `sgauth-preview-gate.v1|${password}`);
}

export function signGateCookie(key: Buffer, nowSeconds: number): string {
  const exp = nowSeconds + GATE_MAX_AGE;
  const mac = hmac(key, `v1.${exp}`).toString("base64url");
  return `${exp}.${mac}`;
}

export function verifyGateCookie(
  key: Buffer,
  value: string | undefined,
  nowSeconds: number,
): boolean {
  if (!value) return false;
  const parts = value.split(".");
  if (parts.length !== 2) return false;
  const [expRaw, macRaw] = parts;
  if (!/^[1-9]\d{0,15}$/.test(expRaw)) return false;
  const exp = Number(expRaw);
  if (exp <= nowSeconds) return false;
  if (exp > nowSeconds + GATE_MAX_AGE + CLOCK_SKEW_SECONDS) return false;
  const given = Buffer.from(macRaw, "base64url");
  const expected = hmac(key, `v1.${exp}`);
  if (given.length !== expected.length) return false;
  return timingSafeEqual(given, expected);
}

function sha256(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

export function passwordMatches(input: string, expected: string): boolean {
  return timingSafeEqual(sha256(input), sha256(expected));
}

/** Returns `raw` only when it is a same-site absolute path outside the gate. */
export function safeNextPath(raw: string | null | undefined): string {
  if (
    !raw ||
    raw.length > 2048 ||
    !raw.startsWith("/") ||
    raw.startsWith("//") ||
    raw.startsWith("/\\") ||
    /[\u0000-\u001f\u007f]/.test(raw)
  ) {
    return "/";
  }
  const pathname = raw.split(/[?#]/, 1)[0];
  return isGatePath(pathname) ? "/" : raw;
}

export interface AttemptResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

export interface AttemptLimiter {
  hit(key: string, nowMs: number): AttemptResult;
}

interface LimiterOptions {
  limit: number;
  windowMs: number;
  maxKeys: number;
}

/** In-memory fixed window per key. Per instance, not shared. */
export function createAttemptLimiter(options: LimiterOptions): AttemptLimiter {
  const windows = new Map<string, { count: number; resetAt: number }>();
  return {
    hit(key, nowMs) {
      for (const [k, w] of windows) {
        if (w.resetAt <= nowMs) windows.delete(k);
      }
      let entry = windows.get(key);
      if (!entry) {
        // Map iteration order is insertion order, so the first key is oldest.
        while (windows.size >= options.maxKeys) {
          const oldest = windows.keys().next().value;
          if (oldest === undefined) break;
          windows.delete(oldest);
        }
        entry = { count: 0, resetAt: nowMs + options.windowMs };
        windows.set(key, entry);
      }
      entry.count += 1;
      const retryAfterSeconds = Math.max(
        1,
        Math.ceil((entry.resetAt - nowMs) / 1000),
      );
      return { allowed: entry.count <= options.limit, retryAfterSeconds };
    },
  };
}

export const unlockLimiter = createAttemptLimiter({
  limit: 10,
  windowMs: 15 * 60_000,
  maxKeys: 10_000,
});

export { clientIp } from "@/lib/client-ip";
