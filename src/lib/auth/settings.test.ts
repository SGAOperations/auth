import { describe, expect, it } from "vitest";
import { resolveCookiePolicy } from "@/lib/auth/cookies";
import {
  parseAuthEnv,
  resolveBaseURL,
  type SgauthEnv,
} from "@/lib/auth/settings";

const SECRET = "a".repeat(32);

// Spreading would invoke the getters, so the input is built as one object.
function inputWithThrowingVercelFields(sgauthEnv: SgauthEnv) {
  return {
    sgauthEnv,
    get vercelUrl(): string {
      throw new Error("VERCEL_URL was read");
    },
    get vercelBranchUrl(): string {
      throw new Error("VERCEL_BRANCH_URL was read");
    },
  };
}

describe("resolveBaseURL", () => {
  it("resolves production to the fixed URL", () => {
    expect(resolveBaseURL({ sgauthEnv: "production" })).toBe(
      "https://auth.northeasternsga.com",
    );
  });

  it("resolves dev to the fixed URL", () => {
    expect(resolveBaseURL({ sgauthEnv: "dev" })).toBe(
      "https://auth-dev.northeasternsga.com",
    );
  });

  it("resolves local to the local hostname", () => {
    expect(resolveBaseURL({ sgauthEnv: "local" })).toBe(
      "http://auth.sga.localhost:3000",
    );
  });

  it("never reads Vercel URLs for production", () => {
    expect(resolveBaseURL(inputWithThrowingVercelFields("production"))).toBe(
      "https://auth.northeasternsga.com",
    );
  });

  it("never reads Vercel URLs for dev", () => {
    expect(resolveBaseURL(inputWithThrowingVercelFields("dev"))).toBe(
      "https://auth-dev.northeasternsga.com",
    );
  });

  it("never reads Vercel URLs for local", () => {
    expect(resolveBaseURL(inputWithThrowingVercelFields("local"))).toBe(
      "http://auth.sga.localhost:3000",
    );
  });

  it("prefers the branch URL for preview", () => {
    expect(
      resolveBaseURL({
        sgauthEnv: "preview",
        vercelBranchUrl: "branch.vercel.app",
        vercelUrl: "deploy.vercel.app",
      }),
    ).toBe("https://branch.vercel.app");
  });

  it("falls back to VERCEL_URL for preview", () => {
    expect(
      resolveBaseURL({ sgauthEnv: "preview", vercelUrl: "deploy.vercel.app" }),
    ).toBe("https://deploy.vercel.app");
  });

  it("throws for preview with no Vercel URL", () => {
    expect(() => resolveBaseURL({ sgauthEnv: "preview" })).toThrow(
      /VERCEL_BRANCH_URL/,
    );
  });
});

describe("parseAuthEnv", () => {
  it("accepts a 32-character secret", () => {
    const result = parseAuthEnv({
      SGAUTH_ENV: "local",
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(result.secret).toBe(SECRET);
    expect(result.sgauthEnv).toBe("local");
  });

  it("rejects a missing secret and names the variable", () => {
    expect(() => parseAuthEnv({ SGAUTH_ENV: "local" })).toThrow(
      /Invalid auth environment:\n- BETTER_AUTH_SECRET/,
    );
  });

  it("rejects a 31-character secret without echoing it", () => {
    const short = "b".repeat(31);
    let message = "";
    try {
      parseAuthEnv({ SGAUTH_ENV: "local", BETTER_AUTH_SECRET: short });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).not.toContain(short);
  });

  it("rejects a missing SGAUTH_ENV", () => {
    expect(() => parseAuthEnv({ BETTER_AUTH_SECRET: SECRET })).toThrow(
      /SGAUTH_ENV/,
    );
  });

  it("rejects an unknown SGAUTH_ENV", () => {
    expect(() =>
      parseAuthEnv({ SGAUTH_ENV: "staging", BETTER_AUTH_SECRET: SECRET }),
    ).toThrow(/SGAUTH_ENV/);
  });

  it("returns VERCEL_ENV as vercelEnv, and undefined when unset", () => {
    const base = { SGAUTH_ENV: "local", BETTER_AUTH_SECRET: SECRET };
    expect(parseAuthEnv(base).vercelEnv).toBeUndefined();
    expect(parseAuthEnv({ ...base, VERCEL_ENV: "" }).vercelEnv).toBeUndefined();
    expect(parseAuthEnv({ ...base, VERCEL_ENV: "preview" }).vercelEnv).toBe(
      "preview",
    );
  });

  it.each(["production", "dev", "local"] as const)(
    "returns the cookie policy for %s",
    (sgauthEnv) => {
      const result = parseAuthEnv({
        SGAUTH_ENV: sgauthEnv,
        BETTER_AUTH_SECRET: SECRET,
        SGAUTH_PREVIEW_GATE: "off",
      });
      expect(result.cookies).toEqual(resolveCookiePolicy(sgauthEnv));
    },
  );

  it("leaves trusted origins to the product registry", () => {
    const result = parseAuthEnv({
      SGAUTH_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(result).not.toHaveProperty("trustedOrigins");
  });
});

describe("parseAuthEnv secrets", () => {
  const NEW = "n".repeat(32);
  const OLD = "o".repeat(32);
  const base = { SGAUTH_ENV: "local", BETTER_AUTH_SECRET: SECRET };

  it("signs with the single secret when no versions are set", () => {
    const result = parseAuthEnv(base);
    expect(result.secret).toBe(SECRET);
    expect(result.legacySecret).toBe(SECRET);
    expect(result.secrets).toBeUndefined();
  });

  it("treats an empty BETTER_AUTH_SECRETS as unset", () => {
    const result = parseAuthEnv({ ...base, BETTER_AUTH_SECRETS: "" });
    expect(result.secrets).toBeUndefined();
    expect(result.secret).toBe(SECRET);
  });

  it("signs with the first version and keeps the legacy secret to decrypt", () => {
    const result = parseAuthEnv({
      ...base,
      BETTER_AUTH_SECRETS: `2:${NEW},1:${OLD}`,
    });
    expect(result.secrets).toEqual([
      { version: 2, value: NEW },
      { version: 1, value: OLD },
    ]);
    expect(result.secret).toBe(NEW);
    expect(result.legacySecret).toBe(SECRET);
  });

  it("refuses a bad entry by position, never echoing the value", () => {
    const bad = "t".repeat(31);
    let message = "";
    try {
      parseAuthEnv({ ...base, BETTER_AUTH_SECRETS: `1:${NEW},2:${bad}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Invalid auth environment:/);
    expect(message).toContain("BETTER_AUTH_SECRETS: entry #2");
    expect(message).not.toContain(bad);
  });
});

describe("parseAuthEnv gates", () => {
  const PASSWORD = "p".repeat(16);
  const base = { BETTER_AUTH_SECRET: SECRET, VERCEL_URL: "deploy.vercel.app" };

  it.each(["dev", "preview"] as const)(
    "refuses %s without a gate password, naming the variable",
    (sgauthEnv) => {
      expect(() => parseAuthEnv({ ...base, SGAUTH_ENV: sgauthEnv })).toThrow(
        /SGAUTH_PREVIEW_GATE_PASSWORD: required when SGAUTH_ENV is dev or preview/,
      );
    },
  );

  it("treats an empty gate password as unset", () => {
    expect(() =>
      parseAuthEnv({
        ...base,
        SGAUTH_ENV: "dev",
        SGAUTH_PREVIEW_GATE_PASSWORD: "",
      }),
    ).toThrow(/SGAUTH_PREVIEW_GATE_PASSWORD/);
  });

  it.each(["dev", "preview"] as const)(
    "parses %s with the gate explicitly off",
    (sgauthEnv) => {
      const result = parseAuthEnv({
        ...base,
        SGAUTH_ENV: sgauthEnv,
        SGAUTH_PREVIEW_GATE: "off",
      });
      expect(result.previewGate).toBeNull();
    },
  );

  it("returns the password for a gated environment", () => {
    const result = parseAuthEnv({
      ...base,
      SGAUTH_ENV: "dev",
      SGAUTH_PREVIEW_GATE_PASSWORD: PASSWORD,
    });
    expect(result.previewGate).toEqual({ password: PASSWORD });
  });

  it("rejects a 15-character password without echoing it", () => {
    const short = "q".repeat(15);
    let message = "";
    try {
      parseAuthEnv({
        ...base,
        SGAUTH_ENV: "dev",
        SGAUTH_PREVIEW_GATE_PASSWORD: short,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("SGAUTH_PREVIEW_GATE_PASSWORD");
    expect(message).not.toContain(short);
  });

  it.each(["production", "local"] as const)(
    "ignores a set password on %s",
    (sgauthEnv) => {
      const result = parseAuthEnv({
        ...base,
        SGAUTH_ENV: sgauthEnv,
        SGAUTH_PREVIEW_GATE_PASSWORD: PASSWORD,
      });
      expect(result.previewGate).toBeNull();
    },
  );

  it("returns no allowlist in production, even when one is set", () => {
    const result = parseAuthEnv({
      ...base,
      SGAUTH_ENV: "production",
      SGAUTH_SIGNUP_ALLOWLIST: "@example.edu",
    });
    expect(result.signupAllowlist).toBeNull();
  });

  it("returns an empty allowlist on local when unset", () => {
    const result = parseAuthEnv({ ...base, SGAUTH_ENV: "local" });
    expect(result.signupAllowlist?.emails.size).toBe(0);
    expect(result.signupAllowlist?.domains.size).toBe(0);
  });

  it("parses the allowlist outside production", () => {
    const result = parseAuthEnv({
      ...base,
      SGAUTH_ENV: "local",
      SGAUTH_SIGNUP_ALLOWLIST: "a@b.com,@example.edu",
    });
    expect([...(result.signupAllowlist?.emails ?? [])]).toEqual(["a@b.com"]);
    expect([...(result.signupAllowlist?.domains ?? [])]).toEqual([
      "example.edu",
    ]);
  });

  it("reports a malformed allowlist entry by position only", () => {
    const secretish = "not-an-email-zzz";
    let message = "";
    try {
      parseAuthEnv({
        ...base,
        SGAUTH_ENV: "local",
        SGAUTH_SIGNUP_ALLOWLIST: `a@b.com,${secretish}`,
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toMatch(/Invalid auth environment:/);
    expect(message).toContain("SGAUTH_SIGNUP_ALLOWLIST: invalid entry #1");
    expect(message).not.toContain(secretish);
  });
});

describe("parseAuthEnv passkey", () => {
  const base = { BETTER_AUTH_SECRET: SECRET, SGAUTH_PREVIEW_GATE: "off" };

  it.each([
    ["production", "auth.northeasternsga.com", "https://"],
    ["dev", "auth-dev.northeasternsga.com", "https://"],
    ["local", "auth.sga.localhost", "http://"],
  ])("uses the auth host as the relying party in %s", (env, host, scheme) => {
    expect(parseAuthEnv({ ...base, SGAUTH_ENV: env }).passkey).toEqual({
      rpID: host,
      rpName: "Northeastern SGA",
      origin: `${scheme}${host}${env === "local" ? ":3000" : ""}`,
    });
  });

  it("uses the per-deployment host in a preview", () => {
    const { passkey } = parseAuthEnv({
      ...base,
      SGAUTH_ENV: "preview",
      VERCEL_BRANCH_URL: "branch-abc.vercel.app",
    });
    expect(passkey.rpID).toBe("branch-abc.vercel.app");
    expect(passkey.origin).toBe("https://branch-abc.vercel.app");
  });

  it.each(["production", "dev", "local"])(
    "never uses the parent domain as the relying party in %s",
    (env) => {
      const { passkey } = parseAuthEnv({ ...base, SGAUTH_ENV: env });
      expect(passkey.rpID).not.toBe("northeasternsga.com");
    },
  );
});

describe("parseAuthEnv email OTP", () => {
  const base = { SGAUTH_ENV: "local", BETTER_AUTH_SECRET: SECRET };

  it("is disabled with a cap of 100 when both variables are absent", () => {
    expect(parseAuthEnv(base).emailOtp).toEqual({
      enabled: false,
      dailyCap: 100,
    });
  });

  it("treats empty strings as unset", () => {
    expect(
      parseAuthEnv({
        ...base,
        SGAUTH_EMAIL_OTP_ENABLED: "",
        SGAUTH_EMAIL_OTP_DAILY_CAP: "",
      }).emailOtp,
    ).toEqual({ enabled: false, dailyCap: 100 });
  });

  it("is enabled by exactly true", () => {
    expect(
      parseAuthEnv({ ...base, SGAUTH_EMAIL_OTP_ENABLED: "true" }).emailOtp
        .enabled,
    ).toBe(true);
  });

  it("is disabled by false", () => {
    expect(
      parseAuthEnv({ ...base, SGAUTH_EMAIL_OTP_ENABLED: "false" }).emailOtp
        .enabled,
    ).toBe(false);
  });

  it("fails startup on any other flag value, naming the variable", () => {
    expect(() =>
      parseAuthEnv({ ...base, SGAUTH_EMAIL_OTP_ENABLED: "yes" }),
    ).toThrow(/SGAUTH_EMAIL_OTP_ENABLED/);
  });

  it("reads the cap", () => {
    expect(
      parseAuthEnv({ ...base, SGAUTH_EMAIL_OTP_DAILY_CAP: "25" }).emailOtp
        .dailyCap,
    ).toBe(25);
  });

  it("rejects a cap of 0, naming the variable", () => {
    expect(() =>
      parseAuthEnv({ ...base, SGAUTH_EMAIL_OTP_DAILY_CAP: "0" }),
    ).toThrow(/SGAUTH_EMAIL_OTP_DAILY_CAP/);
  });
});
