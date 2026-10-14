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
