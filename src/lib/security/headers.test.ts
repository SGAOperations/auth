import { describe, expect, it } from "vitest";
import { securityHeaders } from "./headers";

function header(key: string): string | undefined {
  return securityHeaders.find((entry) => entry.key === key)?.value;
}

describe("securityHeaders", () => {
  it("sets the five static headers", () => {
    expect(header("X-Frame-Options")).toBe("DENY");
    expect(header("Referrer-Policy")).toBe("strict-origin-when-cross-origin");
    expect(header("X-Content-Type-Options")).toBe("nosniff");
    expect(header("Permissions-Policy")).toContain("camera=()");
    expect(header("Strict-Transport-Security")).toBeDefined();
  });

  it("sends HSTS for a year without includeSubDomains or preload", () => {
    const hsts = header("Strict-Transport-Security");
    expect(hsts).toContain("max-age=31536000");
    expect(hsts).not.toMatch(/includeSubDomains/i);
    expect(hsts).not.toMatch(/preload/i);
  });

  it("leaves passkey permissions at their default", () => {
    expect(header("Permissions-Policy")).not.toContain("publickey-credentials");
  });
});
