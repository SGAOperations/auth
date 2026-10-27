import { describe, expect, it } from "vitest";
import {
  parseRedirectCandidate,
  resolveRedirect,
} from "@/lib/redirect/validate";

const SGAUTH = "https://auth.northeasternsga.com";
const PRODUCT = "https://vaultz.northeasternsga.com";
const ACCOUNT = `${SGAUTH}/account`;

const deps = {
  sgauthOrigin: SGAUTH,
  allowHttpProducts: false,
  isAllowedRedirect: (href: string) => new URL(href).origin === PRODUCT,
};

describe("resolveRedirect open-redirect suite", () => {
  it.each([
    // protocol-relative and backslash tricks
    "//evil.com",
    "///evil.com",
    "/\\evil.com",
    "\\\\evil.com",
    "/\t/evil.com",
    "/\n/evil.com",
    // wrong scheme or origin
    "https://evil.com",
    "http://vaultz.northeasternsga.com/x",
    "https:evil.com",
    "javascript:alert(1)",
    "data:text/html,x",
    // userinfo
    "https://vaultz.northeasternsga.com@evil.com",
    "https://evil.com@vaultz.northeasternsga.com/",
    "https://u:p@vaultz.northeasternsga.com/",
    // homographs, subdomains, ports
    "https://vаultz.northeasternsga.com/",
    "https://xn--vultz-6nf.northeasternsga.com/",
    "https://unregistered.northeasternsga.com/",
    "https://vaultz.northeasternsga.com.evil.com/",
    "https://vaultz.northeasternsga.com:8443/",
    // malformed input
    `${PRODUCT}/${"a".repeat(2049)}`,
    "",
    undefined,
    42,
  ])("lands on /account for %j", async (raw) => {
    expect(await resolveRedirect(raw, deps)).toBe(ACCOUNT);
  });

  it("falls back to /account when the allowlist throws or says no", async () => {
    const target = `${PRODUCT}/purchases/42`;
    expect(
      await resolveRedirect(target, {
        ...deps,
        isAllowedRedirect: () => {
          throw new Error("registry down");
        },
      }),
    ).toBe(ACCOUNT);
    expect(
      await resolveRedirect(target, {
        ...deps,
        isAllowedRedirect: () => false,
      }),
    ).toBe(ACCOUNT);
  });
});

describe("resolveRedirect accepted targets", () => {
  it("strips the fragment from a registered product target", async () => {
    expect(await resolveRedirect(`${PRODUCT}/purchases/42#top`, deps)).toBe(
      `${PRODUCT}/purchases/42`,
    );
  });

  it("normalizes scheme and host case", async () => {
    expect(
      await resolveRedirect(
        "HTTPS://VAULTZ.northeasternsga.com/purchases/42",
        deps,
      ),
    ).toBe(`${PRODUCT}/purchases/42`);
  });

  it("keeps a relative target on SGAuth, without its fragment", async () => {
    expect(await resolveRedirect("/account/security?x=1#a", deps)).toBe(
      `${SGAUTH}/account/security?x=1`,
    );
  });

  it("keeps a dot-segment trick on the SGAuth origin", async () => {
    const result = await resolveRedirect("/..//evil.com", deps);
    expect(new URL(result).origin).toBe(SGAUTH);
    expect(result.startsWith(`${SGAUTH}/`)).toBe(true);
  });

  it("keeps a percent-encoded newline as an inert path on SGAuth", async () => {
    // Only a decoded newline is dangerous, and that one is rejected above.
    expect(await resolveRedirect("/%0a/evil.com", deps)).toBe(
      `${SGAUTH}/%0a/evil.com`,
    );
  });

  it("honors a custom fallback path", async () => {
    expect(await resolveRedirect("//evil.com", deps, "/login")).toBe(
      `${SGAUTH}/login`,
    );
  });
});

describe("parseRedirectCandidate http handling", () => {
  const local = {
    sgauthOrigin: "http://auth.sga.localhost:3000",
    allowHttpProducts: true,
  };

  it("allows an http product only when asked to", () => {
    const raw = "http://vaultz.sga.localhost:3001/x";
    expect(parseRedirectCandidate(raw, local)?.href).toBe(raw);
    expect(
      parseRedirectCandidate(raw, { ...local, allowHttpProducts: false }),
    ).toBeNull();
  });

  it("allows http on the local SGAuth origin itself", () => {
    expect(
      parseRedirectCandidate("http://auth.sga.localhost:3000/account", {
        ...local,
        allowHttpProducts: false,
      })?.pathname,
    ).toBe("/account");
  });
});
