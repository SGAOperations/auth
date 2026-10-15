// Pure on purpose: no `server-only` and no env reads, so it loads anywhere.

export const REDACTED = "[REDACTED]";
const REDACTED_EMAIL = "[REDACTED_EMAIL]";
const CIRCULAR = "[Circular]";
const TRUNCATED = "[Truncated]";
const MAX_DEPTH = 8;

// Compared after lowercasing and stripping "-" and "_", so `Set-Cookie`,
// `set_cookie` and `setCookie` all land on `setcookie`.
const SENSITIVE_KEYS: ReadonlySet<string> = new Set([
  "password",
  "cookie",
  "setcookie",
  "authorization",
  "email",
  "otp",
  "code",
  "backupcodes",
  "apikey",
  "html",
  "text",
  "body",
  "ip",
]);

const SENSITIVE_SUFFIXES = ["password", "token", "secret"] as const;

const JWT_PATTERN = /^eyJ[\w-]+\.[\w-]+\.[\w-]*$/;
const BEARER_PATTERN = /^bearer\s/i;
const EMAIL_PATTERN = /[^\s@<>"']+@[^\s@<>"']+\.[^\s@<>"']+/g;

function isSensitiveKey(key: string): boolean {
  const normalized = key.toLowerCase().replace(/[-_]/g, "");
  return (
    SENSITIVE_KEYS.has(normalized) ||
    SENSITIVE_SUFFIXES.some((suffix) => normalized.endsWith(suffix))
  );
}

function redactString(value: string): string {
  if (JWT_PATTERN.test(value) || BEARER_PATTERN.test(value)) return REDACTED;
  return value.replace(EMAIL_PATTERN, REDACTED_EMAIL);
}

function walk(value: unknown, depth: number, ancestors: object[]): unknown {
  if (typeof value === "string") return redactString(value);
  if (
    value === null ||
    typeof value === "number" ||
    typeof value === "boolean" ||
    value === undefined
  ) {
    return value;
  }
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }

  // Past here `value` is an object.
  if (ancestors.includes(value)) return CIRCULAR;
  if (depth >= MAX_DEPTH) return TRUNCATED;
  const path = [...ancestors, value];

  if (value instanceof Error) {
    const out: Record<string, unknown> = {
      name: value.name,
      message: redactString(value.message),
    };
    if (value.stack !== undefined) out.stack = redactString(value.stack);
    if (value.cause !== undefined) {
      out.cause = walk(value.cause, depth + 1, path);
    }
    return out;
  }

  if (Array.isArray(value)) {
    return value.map((item) => walk(item, depth + 1, path));
  }

  const out: Record<string, unknown> = {};
  for (const [key, entry] of Object.entries(value)) {
    out[key] = isSensitiveKey(key) ? REDACTED : walk(entry, depth + 1, path);
  }
  return out;
}

/**
 * Returns a copy of `value` that is safe to log. Never mutates the input.
 * Keys that name secrets, emails or message bodies are replaced whatever their
 * type, and string values that look like a JWT or a bearer credential are
 * replaced too. Email addresses inside other strings are masked.
 */
export function redact(value: unknown): unknown {
  return walk(value, 0, []);
}
