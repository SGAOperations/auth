import "server-only";
import { createHash } from "node:crypto";
import type { SgauthEnv } from "@/lib/env-schema";
import { normalizeEmail } from "@/lib/auth/policy";
import {
  POLICIES,
  type PolicyName,
  type Rule,
  type RuleKey,
} from "@/lib/rate-limit/policies";

export interface RateLimitResult {
  success: boolean;
  /** Epoch ms at which the window frees a slot. */
  resetMs: number;
  /** Set when the backend let the call through because it timed out. */
  failOpen?: "timeout";
}

export interface RateLimitBackend {
  limit(key: string, rule: Rule): Promise<RateLimitResult>;
}

export interface AlertLog {
  error(msg: string, fields?: Record<string, unknown>): void;
}

export type Identifiers = Partial<Record<RuleKey, string>>;

export interface CheckResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

// Exhaustive on purpose: a new SgauthEnv fails `tsc` until it gets a row.
export function namespaceFor(env: SgauthEnv): string {
  switch (env) {
    case "production":
      return "sgauth:prod:";
    case "dev":
      return "sgauth:dev:";
    case "preview":
      return "sgauth:preview:";
    case "local":
      return "sgauth:local:";
  }
}

export function tooManyRequests(retryAfterSeconds: number): Response {
  return Response.json(
    {
      code: "TOO_MANY_REQUESTS",
      message: "Too many requests. Try again later.",
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

// Raw emails and session tokens never reach the backend. IPs are kept as is,
// and a user id is a UUID rather than PII.
function identifierFor(by: RuleKey, raw: string): string {
  switch (by) {
    case "email":
      return sha256Hex(normalizeEmail(raw));
    case "session":
      return sha256Hex(raw);
    case "ip":
    case "user":
      return raw;
  }
}

const ALERT_INTERVAL_MS = 60_000;

export interface FailOpenEvent {
  policy: PolicyName;
  rule: string;
  reason: "timeout" | "error";
}

interface RateLimiterOptions {
  backend: RateLimitBackend;
  log: AlertLog;
  /**
   * Called right after a fail-open line is written, so at most once per rule
   * per minute per instance. A throwing callback is swallowed.
   */
  onFailOpen?: (event: FailOpenEvent) => void;
  now?: () => number;
}

export function createRateLimiter({
  backend,
  log,
  onFailOpen,
  now = Date.now,
}: RateLimiterOptions) {
  const lastAlert = new Map<string, { at: number; suppressed: number }>();

  // One line per rule per minute per instance, so an outage cannot flood the
  // logs. Never logs the identifier, the key or the error message: the message
  // can carry the REST URL.
  function alertFailOpen(
    policy: PolicyName,
    rule: Rule,
    reason: "timeout" | "error",
    error?: unknown,
  ): void {
    const nowMs = now();
    const previous = lastAlert.get(rule.id);
    if (previous && nowMs - previous.at < ALERT_INTERVAL_MS) {
      previous.suppressed += 1;
      return;
    }
    lastAlert.set(rule.id, { at: nowMs, suppressed: 0 });
    log.error("[ALERT] rate-limit fail-open", {
      policy,
      rule: rule.id,
      reason,
      ...(error instanceof Error ? { errorName: error.name } : {}),
      ...(previous && previous.suppressed > 0
        ? { suppressed: previous.suppressed }
        : {}),
    });
    try {
      onFailOpen?.({ policy, rule: rule.id, reason });
    } catch {
      // A signal must never fail a request.
    }
  }

  async function check(
    policy: PolicyName,
    ids: Identifiers,
  ): Promise<CheckResult> {
    const rules: readonly Rule[] = POLICIES[policy];
    const applicable = rules.flatMap((rule) => {
      const raw = ids[rule.by];
      return raw === undefined
        ? []
        : [{ rule, key: identifierFor(rule.by, raw) }];
    });

    const settled = await Promise.allSettled(
      applicable.map(({ rule, key }) => backend.limit(key, rule)),
    );

    let deniedResetMs = 0;
    let denied = false;
    for (const [index, outcome] of settled.entries()) {
      const { rule } = applicable[index];
      if (outcome.status === "rejected") {
        alertFailOpen(policy, rule, "error", outcome.reason);
      } else if (outcome.value.failOpen) {
        alertFailOpen(policy, rule, outcome.value.failOpen);
      } else if (!outcome.value.success) {
        denied = true;
        deniedResetMs = Math.max(deniedResetMs, outcome.value.resetMs);
      }
    }

    if (!denied) return { allowed: true, retryAfterSeconds: 0 };
    return {
      allowed: false,
      retryAfterSeconds: Math.max(1, Math.ceil((deniedResetMs - now()) / 1000)),
    };
  }

  /**
   * For handlers that key a policy on one identifier, such as the re-auth and
   * admin handlers. Returns the 429 to send, or `null` to carry on.
   */
  async function limitRequest(
    policy: PolicyName,
    identifier: string,
  ): Promise<Response | null> {
    const ids: Identifiers = {};
    for (const rule of POLICIES[policy]) ids[rule.by] = identifier;
    const result = await check(policy, ids);
    return result.allowed ? null : tooManyRequests(result.retryAfterSeconds);
  }

  return { check, limitRequest };
}

export type RateLimiter = ReturnType<typeof createRateLimiter>;
