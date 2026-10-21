import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env-schema";

const SECRET = "a".repeat(32);
const DATABASE_URL = "postgresql://runtime:pw@ep-x-pooler.neon.tech/neondb";

const valid = {
  SGAUTH_ENV: "local",
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
};

const upstash = {
  UPSTASH_REDIS_REST_URL: "https://example-12345.upstash.io",
  UPSTASH_REDIS_REST_TOKEN: "upstash-test-token",
};

const CRON_SECRET = "c".repeat(32);

function messageOf(raw: Record<string, string | undefined>): string {
  try {
    parseServerEnv(raw);
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected parseServerEnv to throw");
}

describe("parseServerEnv", () => {
  it("parses a valid local env and defaults NODE_ENV", () => {
    const env = parseServerEnv(valid);
    expect(env.SGAUTH_ENV).toBe("local");
    expect(env.NODE_ENV).toBe("development");
  });

  it("reports a missing secret by name", () => {
    expect(messageOf({ ...valid, BETTER_AUTH_SECRET: undefined })).toContain(
      "BETTER_AUTH_SECRET: missing",
    );
  });

  it("reports an empty string the same as unset", () => {
    expect(messageOf({ ...valid, BETTER_AUTH_SECRET: "" })).toContain(
      "BETTER_AUTH_SECRET: missing",
    );
  });

  it("lists every bad variable once, without echoing values", () => {
    const shortSecret = "s".repeat(10);
    const badUrl = "mysql://user:hunter2@host/db";
    const message = messageOf({
      ...valid,
      BETTER_AUTH_SECRET: shortSecret,
      DATABASE_URL: badUrl,
    });
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).toContain("DATABASE_URL");
    expect(message).not.toContain(shortSecret);
    expect(message).not.toContain("hunter2");
  });

  it("names the active SGAUTH_ENV in the header", () => {
    expect(messageOf({ ...valid, DATABASE_URL: undefined })).toContain(
      "(SGAUTH_ENV=local)",
    );
  });

  it("rejects an unknown SGAUTH_ENV", () => {
    const message = messageOf({ ...valid, SGAUTH_ENV: "staging" });
    expect(message).toContain("SGAUTH_ENV");
    expect(message).toContain("unset or invalid");
  });

  it("rejects a service key without its pair", () => {
    expect(messageOf({ ...valid, RESEND_API_KEY: "re_key" })).toContain(
      "RESEND_FROM_EMAIL: missing",
    );
  });

  it("accepts a complete service pair", () => {
    const env = parseServerEnv({
      ...valid,
      RESEND_API_KEY: "re_key",
      RESEND_FROM_EMAIL: "auth@example.com",
    });
    expect(env.RESEND_FROM_EMAIL).toBe("auth@example.com");
  });

  describe("Upstash rate-limit store", () => {
    it.each(["production", "dev"])(
      "is required when SGAUTH_ENV=%s",
      (sgauthEnv) => {
        const message = messageOf({ ...valid, SGAUTH_ENV: sgauthEnv });
        expect(message).toContain("UPSTASH_REDIS_REST_URL: missing");
        expect(message).toContain("UPSTASH_REDIS_REST_TOKEN: missing");
      },
    );

    it.each(["production", "dev"])("parses on %s when set", (sgauthEnv) => {
      const env = parseServerEnv({
        ...valid,
        ...upstash,
        CRON_SECRET,
        SGAUTH_ENV: sgauthEnv,
      });
      expect(env.UPSTASH_REDIS_REST_URL).toBe(upstash.UPSTASH_REDIS_REST_URL);
    });

    it.each(["preview", "local"])(
      "is optional when SGAUTH_ENV=%s",
      (sgauthEnv) => {
        const env = parseServerEnv({ ...valid, SGAUTH_ENV: sgauthEnv });
        expect(env.UPSTASH_REDIS_REST_URL).toBeUndefined();
      },
    );

    it("still rejects the URL without the token on local", () => {
      expect(
        messageOf({
          ...valid,
          UPSTASH_REDIS_REST_URL: upstash.UPSTASH_REDIS_REST_URL,
        }),
      ).toContain("UPSTASH_REDIS_REST_TOKEN: missing");
    });
  });

  describe("job runner secret", () => {
    const deployed = { ...valid, ...upstash };

    it.each(["production", "dev"])(
      "is required when SGAUTH_ENV=%s",
      (sgauthEnv) => {
        expect(messageOf({ ...deployed, SGAUTH_ENV: sgauthEnv })).toContain(
          "CRON_SECRET: missing",
        );
      },
    );

    it.each(["production", "dev"])("parses on %s when set", (sgauthEnv) => {
      const env = parseServerEnv({
        ...deployed,
        CRON_SECRET,
        SGAUTH_ENV: sgauthEnv,
      });
      expect(env.CRON_SECRET).toBe(CRON_SECRET);
    });

    it.each(["preview", "local"])(
      "is optional when SGAUTH_ENV=%s",
      (sgauthEnv) => {
        const env = parseServerEnv({ ...valid, SGAUTH_ENV: sgauthEnv });
        expect(env.CRON_SECRET).toBeUndefined();
      },
    );

    it("rejects a short secret without echoing it", () => {
      const short = "z".repeat(31);
      const message = messageOf({ ...valid, CRON_SECRET: short });
      expect(message).toContain("CRON_SECRET");
      expect(message).not.toContain(short);
    });
  });

  it("strips undeclared keys, including the retired cookie variables", () => {
    const env = parseServerEnv({
      ...valid,
      SGAUTH_COOKIE_DOMAIN: "sga.localhost",
      SGAUTH_COOKIE_PREFIX: "sgauth-local",
      SOMETHING_ELSE: "x",
    });
    expect(env).not.toHaveProperty("SGAUTH_COOKIE_DOMAIN");
    expect(env).not.toHaveProperty("SGAUTH_COOKIE_PREFIX");
    expect(env).not.toHaveProperty("SOMETHING_ELSE");
  });

  it("accepts the preview gate and signup allowlist variables", () => {
    const env = parseServerEnv({
      ...valid,
      ...upstash,
      CRON_SECRET,
      SGAUTH_ENV: "dev",
      SGAUTH_SIGNUP_ALLOWLIST: "@example.edu",
      SGAUTH_PREVIEW_GATE_PASSWORD: "p".repeat(16),
      SGAUTH_PREVIEW_GATE: "on",
    });
    expect(env.SGAUTH_PREVIEW_GATE).toBe("on");
  });

  it("rejects a 15-character gate password without echoing it", () => {
    const short = "q".repeat(15);
    const message = messageOf({
      ...valid,
      SGAUTH_PREVIEW_GATE_PASSWORD: short,
    });
    expect(message).toContain("SGAUTH_PREVIEW_GATE_PASSWORD");
    expect(message).not.toContain(short);
  });

  describe("local seed Primary Admin", () => {
    const seed = {
      SEED_PRIMARY_ADMIN_EMAIL: "  Admin@Example.COM ",
      SEED_PRIMARY_ADMIN_PASSWORD: "correct-horse-battery",
    };

    it("parses on local, trimming and lower-casing the email", () => {
      const env = parseServerEnv({ ...valid, ...seed });
      expect(env.SEED_PRIMARY_ADMIN_EMAIL).toBe("admin@example.com");
      expect(env.SEED_PRIMARY_ADMIN_PASSWORD).toBe(
        seed.SEED_PRIMARY_ADMIN_PASSWORD,
      );
    });

    it("requires the password when the email is set", () => {
      expect(
        messageOf({
          ...valid,
          SEED_PRIMARY_ADMIN_EMAIL: seed.SEED_PRIMARY_ADMIN_EMAIL,
        }),
      ).toContain("SEED_PRIMARY_ADMIN_PASSWORD: missing");
    });

    it("rejects an 11-character password without echoing it", () => {
      const short = "k".repeat(11);
      const message = messageOf({
        ...valid,
        ...seed,
        SEED_PRIMARY_ADMIN_PASSWORD: short,
      });
      expect(message).toContain("SEED_PRIMARY_ADMIN_PASSWORD");
      expect(message).not.toContain(short);
    });

    it("rejects an invalid email", () => {
      expect(
        messageOf({ ...valid, ...seed, SEED_PRIMARY_ADMIN_EMAIL: "nope" }),
      ).toContain("SEED_PRIMARY_ADMIN_EMAIL");
    });

    it.each(["dev", "preview", "production"])(
      "refuses every seed key when SGAUTH_ENV=%s",
      (sgauthEnv) => {
        const message = messageOf({
          ...valid,
          ...seed,
          SGAUTH_ENV: sgauthEnv,
          SEED_PRIMARY_ADMIN_NAME: "Admin",
        });
        for (const key of [
          "SEED_PRIMARY_ADMIN_EMAIL",
          "SEED_PRIMARY_ADMIN_PASSWORD",
          "SEED_PRIMARY_ADMIN_NAME",
        ]) {
          expect(message).toContain(
            `${key}: only allowed when SGAUTH_ENV=local`,
          );
        }
        expect(message).not.toContain(seed.SEED_PRIMARY_ADMIN_PASSWORD);
      },
    );
  });
});
