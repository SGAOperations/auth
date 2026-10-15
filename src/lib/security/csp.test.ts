import { describe, expect, it } from "vitest";
import { CSP_MODES, parseServerEnv } from "@/lib/env-schema";
import { buildCsp, cspHeaderName, generateNonce } from "./csp";

const options = { nonce: "abc123", isDev: false, reportUri: "/api/csp-report" };

describe("buildCsp", () => {
  it("puts the nonce in script-src with strict-dynamic", () => {
    const csp = buildCsp(options);
    expect(csp).toContain(
      "script-src 'self' 'nonce-abc123' 'strict-dynamic'; ",
    );
  });

  it("allows unsafe-eval only in development", () => {
    expect(buildCsp(options)).not.toContain("'unsafe-eval'");
    expect(buildCsp({ ...options, isDev: true })).toContain("'unsafe-eval'");
  });

  it("omits upgrade-insecure-requests in development", () => {
    expect(buildCsp(options)).toContain("upgrade-insecure-requests");
    expect(buildCsp({ ...options, isDev: true })).not.toContain(
      "upgrade-insecure-requests",
    );
  });

  it("denies framing, plugins and foreign bases or forms", () => {
    const csp = buildCsp(options);
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
    expect(csp).toContain("base-uri 'self'");
    expect(csp).toContain("form-action 'self'");
  });

  it("reports to the first-party endpoint", () => {
    const csp = buildCsp(options);
    expect(csp).toContain("report-uri /api/csp-report");
    expect(csp).toContain("report-to csp-endpoint");
  });
});

describe("generateNonce", () => {
  it("returns a different value each call", () => {
    expect(generateNonce()).not.toBe(generateNonce());
  });
});

describe("cspHeaderName", () => {
  it("names the header by mode", () => {
    expect(cspHeaderName("report-only")).toBe(
      "Content-Security-Policy-Report-Only",
    );
    expect(cspHeaderName("enforce")).toBe("Content-Security-Policy");
  });
});

describe("SGAUTH_CSP_MODE", () => {
  const base = {
    SGAUTH_ENV: "local",
    DATABASE_URL: "postgresql://u:p@localhost:5432/db",
    BETTER_AUTH_SECRET: "x".repeat(32),
  };

  it("lists both modes", () => {
    expect(CSP_MODES).toEqual(["report-only", "enforce"]);
  });

  it("defaults to report-only when unset", () => {
    expect(parseServerEnv(base).SGAUTH_CSP_MODE).toBe("report-only");
  });

  it("accepts enforce", () => {
    expect(
      parseServerEnv({ ...base, SGAUTH_CSP_MODE: "enforce" }).SGAUTH_CSP_MODE,
    ).toBe("enforce");
  });

  it("rejects an unknown mode", () => {
    expect(() =>
      parseServerEnv({ ...base, SGAUTH_CSP_MODE: "enforcing" }),
    ).toThrow(/SGAUTH_CSP_MODE/);
  });
});
