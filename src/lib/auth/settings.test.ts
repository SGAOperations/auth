import { describe, expect, it } from "vitest";
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

  it("sets trustedOrigins to the baseURL", () => {
    const result = parseAuthEnv({
      SGAUTH_ENV: "production",
      BETTER_AUTH_SECRET: SECRET,
    });
    expect(result.trustedOrigins).toEqual([result.baseURL]);
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
