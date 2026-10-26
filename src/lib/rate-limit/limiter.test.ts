import { describe, expect, it, vi } from "vitest";
import {
  createRateLimiter,
  namespaceFor,
  type Identifiers,
  type RateLimitBackend,
} from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import { createUpstashBackend } from "@/lib/rate-limit/upstash-backend";
import {
  POLICIES,
  type PolicyName,
  type Rule,
} from "@/lib/rate-limit/policies";
import type { Redis } from "@upstash/redis";

const START = 1_700_000_000_000;

function setup(backend?: RateLimitBackend) {
  let nowMs = START;
  const now = () => nowMs;
  const log = { error: vi.fn() };
  const limiter = createRateLimiter({
    backend: backend ?? createMemoryBackend({ now }),
    log,
    now,
  });
  return {
    limiter,
    log,
    advance: (ms: number) => {
      nowMs += ms;
    },
  };
}

const ids: Identifiers = {
  ip: "203.0.113.7",
  email: "student@northeastern.edu",
  session: "session-token-value",
  user: "0192f0a0-0000-7000-8000-000000000001",
};

const tightest = (policy: PolicyName): Rule =>
  [...POLICIES[policy]].sort((a, b) => a.limit - b.limit)[0];

describe("check", () => {
  it.each(Object.keys(POLICIES) as PolicyName[])(
    "%s: the limit is allowed and the next request is denied",
    async (policy) => {
      const { limiter } = setup();
      const rule = tightest(policy);
      for (let i = 0; i < rule.limit; i++) {
        expect((await limiter.check(policy, ids)).allowed).toBe(true);
      }
      const denied = await limiter.check(policy, ids);
      expect(denied.allowed).toBe(false);
      expect(denied.retryAfterSeconds).toBe(rule.windowSeconds);
    },
  );

  it.each(Object.keys(POLICIES) as PolicyName[])(
    "%s: allows again after the window",
    async (policy) => {
      const { limiter, advance } = setup();
      const rule = tightest(policy);
      for (let i = 0; i <= rule.limit; i++) await limiter.check(policy, ids);
      expect((await limiter.check(policy, ids)).allowed).toBe(false);
      advance(rule.windowSeconds * 1000 + 1);
      expect((await limiter.check(policy, ids)).allowed).toBe(true);
    },
  );

  it("counts down the remaining window in Retry-After", async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 10; i++) await limiter.check("signIn", ids);
    advance(25_000);
    const denied = await limiter.check("signIn", ids);
    expect(denied.retryAfterSeconds).toBe(35);
  });

  it("hits the hourly sign-in limit while staying under 10 a minute", async () => {
    const { limiter, advance } = setup();
    for (let i = 0; i < 50; i++) {
      expect((await limiter.check("signIn", ids)).allowed).toBe(true);
      advance(7_000);
    }
    const denied = await limiter.check("signIn", ids);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBeGreaterThan(60);
  });

  it("blocks a reset by email across IPs and by IP across emails", async () => {
    const { limiter } = setup();
    for (let i = 0; i < 3; i++) {
      await limiter.check("passwordReset", {
        ip: `10.0.0.${i}`,
        email: "a@x.edu",
      });
    }
    expect(
      (
        await limiter.check("passwordReset", {
          ip: "10.9.9.9",
          email: "a@x.edu",
        })
      ).allowed,
    ).toBe(false);

    const other = setup();
    for (let i = 0; i < 3; i++) {
      await other.limiter.check("passwordReset", {
        ip: "10.0.0.1",
        email: `user${i}@x.edu`,
      });
    }
    expect(
      (
        await other.limiter.check("passwordReset", {
          ip: "10.0.0.1",
          email: "fresh@x.edu",
        })
      ).allowed,
    ).toBe(false);
  });

  it("shares one bucket across case and padding variants of an email", async () => {
    const { limiter } = setup();
    const variants = [
      "A@Northeastern.edu ",
      " a@northeastern.EDU",
      "a@northeastern.edu",
    ];
    for (const email of variants) {
      await limiter.check("verificationResend", { email });
    }
    expect(
      (
        await limiter.check("verificationResend", {
          email: "a@northeastern.edu",
        })
      ).allowed,
    ).toBe(false);
  });

  it("skips a rule whose identifier is absent", async () => {
    const { limiter } = setup();
    for (let i = 0; i < 20; i++) {
      expect((await limiter.check("passwordReset", {})).allowed).toBe(true);
    }
  });
});

describe("limitRequest", () => {
  it.each(["reauth", "adminMutation", "token"] as const)(
    "%s: returns a 429 with Retry-After once over the limit",
    async (policy) => {
      const { limiter } = setup();
      const rule = POLICIES[policy][0];
      for (let i = 0; i < rule.limit; i++) {
        expect(await limiter.limitRequest(policy, "subject")).toBeNull();
      }
      const response = await limiter.limitRequest(policy, "subject");
      expect(response?.status).toBe(429);
      expect(response?.headers.get("Retry-After")).toBe(
        String(rule.windowSeconds),
      );
      expect(response?.headers.get("Cache-Control")).toBe("no-store");
      expect(await response?.json()).toEqual({
        code: "TOO_MANY_REQUESTS",
        message: "Too many requests. Try again later.",
      });
    },
  );

  it("limits subjects independently", async () => {
    const { limiter } = setup();
    for (let i = 0; i < 5; i++) await limiter.limitRequest("reauth", "alice");
    expect(await limiter.limitRequest("reauth", "alice")).not.toBeNull();
    expect(await limiter.limitRequest("reauth", "bob")).toBeNull();
  });
});

describe("namespacing and hashing", () => {
  it("namespaces each environment", () => {
    expect(namespaceFor("production")).toBe("sgauth:prod:");
    expect(namespaceFor("dev")).toBe("sgauth:dev:");
    expect(namespaceFor("preview")).toBe("sgauth:preview:");
    expect(namespaceFor("local")).toBe("sgauth:local:");
  });

  it.each([
    ["production", "sgauth:prod:"],
    ["dev", "sgauth:dev:"],
  ] as const)("%s keys begin with %s", async (sgauthEnv, expected) => {
    const prefixes: string[] = [];
    const backend = createUpstashBackend({
      redis: {} as Redis,
      prefix: namespaceFor(sgauthEnv),
      createRatelimit: (_rule, prefix) => {
        prefixes.push(prefix);
        return { limit: async () => ({ success: true, reset: 0 }) };
      },
    });
    const { limiter } = setup(backend);
    await limiter.check("signIn", ids);
    await limiter.check("passwordReset", ids);
    expect(prefixes.length).toBeGreaterThan(0);
    for (const prefix of prefixes)
      expect(prefix.startsWith(expected)).toBe(true);
  });

  it("never hands a raw email or session token to the backend", async () => {
    const keys: string[] = [];
    const backend: RateLimitBackend = {
      limit: async (key) => {
        keys.push(key);
        return { success: true, resetMs: 0 };
      },
    };
    const { limiter } = setup(backend);
    for (const policy of Object.keys(POLICIES) as PolicyName[]) {
      await limiter.check(policy, ids);
    }
    expect(keys.length).toBe(15);
    for (const key of keys) {
      expect(key).not.toContain("student@northeastern.edu");
      expect(key).not.toContain("session-token-value");
    }
    expect(keys).toContain(ids.ip);
    expect(keys).toContain(ids.user);
  });
});

describe("fail open", () => {
  const failing: Record<string, RateLimitBackend> = {
    "a throwing backend": {
      limit: async () => {
        throw new Error("https://secret-host.upstash.io unreachable");
      },
    },
    "a timeout": {
      limit: async () => ({ success: true, resetMs: 0, failOpen: "timeout" }),
    },
  };

  it.each(Object.keys(failing))("allows the request on %s", async (name) => {
    const { limiter, log } = setup(failing[name]);
    expect((await limiter.check("signIn", ids)).allowed).toBe(true);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error).toHaveBeenCalledWith(
      "[ALERT] rate-limit fail-open",
      expect.objectContaining({ policy: "signIn" }),
    );
  });

  it("logs nothing sensitive", async () => {
    const { limiter, log } = setup(failing["a throwing backend"]);
    await limiter.check("passwordReset", ids);
    const logged = JSON.stringify(log.error.mock.calls);
    expect(logged).not.toContain(ids.ip);
    expect(logged).not.toContain(ids.email);
    expect(logged).not.toContain("secret-host");
  });

  it("alerts once per rule per minute, then reports what it suppressed", async () => {
    const { limiter, log, advance } = setup(failing["a throwing backend"]);
    await limiter.check("verificationResend", ids);
    await limiter.check("verificationResend", ids);
    await limiter.check("verificationResend", ids);
    expect(log.error).toHaveBeenCalledTimes(1);

    advance(61_000);
    await limiter.check("verificationResend", ids);
    expect(log.error).toHaveBeenCalledTimes(2);
    expect(log.error.mock.calls[1][1]).toMatchObject({ suppressed: 2 });
  });

  it("still denies when another rule of the policy is over its limit", async () => {
    const memory = createMemoryBackend({ now: () => START });
    const backend: RateLimitBackend = {
      limit: (key, rule) =>
        rule.by === "email"
          ? Promise.reject(new Error("down"))
          : memory.limit(key, rule),
    };
    const { limiter } = setup(backend);
    for (let i = 0; i < 3; i++) await limiter.check("passwordReset", ids);
    expect((await limiter.check("passwordReset", ids)).allowed).toBe(false);
  });
});
