import { describe, expect, it } from "vitest";
import { parseServerEnv } from "@/lib/env-schema";

const SECRET = "a".repeat(32);
const DATABASE_URL = "postgresql://runtime:pw@ep-x-pooler.neon.tech/neondb";

const valid = {
  SGAUTH_ENV: "local",
  DATABASE_URL,
  BETTER_AUTH_SECRET: SECRET,
};

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

  it("accepts the gate and allowlist variables from #134", () => {
    const env = parseServerEnv({
      ...valid,
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
});
