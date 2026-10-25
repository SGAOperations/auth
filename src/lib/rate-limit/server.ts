import "server-only";
import { Redis } from "@upstash/redis";
import { env } from "@/lib/env";
import { deferSignal } from "@/lib/alerts/signals";
import { resolveCookiePolicy, sessionCookieName } from "@/lib/auth/cookies";
import { logger } from "@/lib/log";
import { createAuthRouteLimiter } from "@/lib/rate-limit/auth-route";
import {
  createRateLimiter,
  namespaceFor,
  type RateLimitBackend,
} from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import { createUpstashBackend } from "@/lib/rate-limit/upstash-backend";

function buildBackend(): RateLimitBackend {
  // Never Redis.fromEnv(): env is read only through src/lib/env.ts.
  if (env.UPSTASH_REDIS_REST_URL && env.UPSTASH_REDIS_REST_TOKEN) {
    return createUpstashBackend({
      redis: new Redis({
        url: env.UPSTASH_REDIS_REST_URL,
        token: env.UPSTASH_REDIS_REST_TOKEN,
      }),
      prefix: namespaceFor(env.SGAUTH_ENV),
    });
  }
  // The env schema allows this on local and preview only.
  logger.warn(
    "Rate limiting is using the in-memory backend (UPSTASH_REDIS_REST_* unset); limits are per instance.",
  );
  return createMemoryBackend();
}

const limiter = createRateLimiter({
  backend: buildBackend(),
  log: logger,
  onFailOpen: (detail) => deferSignal({ kind: "RATE_LIMIT_FAIL_OPEN", detail }),
});

/** For handlers that key a policy on one id, such as re-auth and admin. */
export const limitRequest = limiter.limitRequest;

/** For handlers that key a policy on several identifiers, such as the IP. */
export const checkRateLimit = limiter.check;

export const withAuthRateLimit = createAuthRouteLimiter({
  limiter,
  sessionCookieName: sessionCookieName(resolveCookiePolicy(env.SGAUTH_ENV)),
});
