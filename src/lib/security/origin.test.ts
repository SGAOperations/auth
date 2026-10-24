import { describe, expect, it } from "vitest";
import { checkOrigin, createOriginGuard, isOriginEnforcedPath } from "./origin";

const OWN = "https://auth.northeasternsga.com";
const PRODUCT = "https://product.northeasternsga.com";
const TRUSTED = [OWN, PRODUCT];

function check(
  method: string,
  headers: Record<string, string> = {},
  trustedOrigins: readonly string[] = TRUSTED,
) {
  return checkOrigin({ method, headers: new Headers(headers), trustedOrigins });
}

describe("isOriginEnforcedPath", () => {
  it.each(["/api/sgauth", "/api/sgauth/admin/users"])("enforces %s", (path) => {
    expect(isOriginEnforcedPath(path)).toBe(true);
  });

  it.each(["/api/sgauthx", "/api/auth/sign-in/email", "/api/csp-report", "/"])(
    "does not enforce %s",
    (path) => {
      expect(isOriginEnforcedPath(path)).toBe(false);
    },
  );
});

describe("checkOrigin passes", () => {
  it.each(["GET", "HEAD", "OPTIONS"])("%s with no headers", (method) => {
    expect(check(method)).toEqual({ ok: true });
  });

  it("enforces a lowercase method", () => {
    expect(check("post")).toEqual({ ok: false, reason: "missing_origin" });
    expect(check("post", { Origin: PRODUCT })).toEqual({ ok: true });
  });

  it("a trusted Origin with Sec-Fetch-Site same-site", () => {
    expect(
      check("POST", { Origin: PRODUCT, "Sec-Fetch-Site": "same-site" }),
    ).toEqual({ ok: true });
  });

  it("SGAuth's own origin with same-origin", () => {
    expect(
      check("POST", { Origin: OWN, "Sec-Fetch-Site": "same-origin" }),
    ).toEqual({ ok: true });
  });

  it("falls back to a trusted Referer, keeping only its origin", () => {
    expect(check("POST", { Referer: `${PRODUCT}/some/path?x=1` })).toEqual({
      ok: true,
    });
  });

  it("normalizes case and the default port", () => {
    expect(
      check("POST", { Origin: "HTTPS://Product.NortheasternSGA.com:443" }),
    ).toEqual({ ok: true });
  });
});

describe("checkOrigin rejects", () => {
  it("cross_site: a trusted Origin with Sec-Fetch-Site cross-site", () => {
    expect(
      check("POST", { Origin: PRODUCT, "Sec-Fetch-Site": "cross-site" }),
    ).toEqual({ ok: false, reason: "cross_site" });
  });

  it("null_origin", () => {
    expect(check("POST", { Origin: "null" })).toEqual({
      ok: false,
      reason: "null_origin",
    });
  });

  it("missing_origin: neither Origin nor Referer", () => {
    expect(check("POST")).toEqual({ ok: false, reason: "missing_origin" });
  });

  it.each([
    "not a url",
    "ftp://x.northeasternsga.com",
    "https://a.northeasternsga.com/path",
    "https://a.northeasternsga.com?x=1",
    "https://a.northeasternsga.com#frag",
    "https://user:pw@a.northeasternsga.com",
  ])("malformed_origin: Origin %s", (origin) => {
    expect(check("POST", { Origin: origin })).toEqual({
      ok: false,
      reason: "malformed_origin",
    });
  });

  it("malformed_origin: an unparseable Referer", () => {
    expect(check("POST", { Referer: "not a url" })).toEqual({
      ok: false,
      reason: "malformed_origin",
    });
  });

  it.each([
    "https://unregistered.northeasternsga.com",
    "https://evil.vercel.app",
    "http://product.northeasternsga.com",
    "https://product.northeasternsga.com:8443",
    "https://product.northeasternsga.com.evil.com",
  ])("untrusted_origin: %s", (origin) => {
    expect(check("POST", { Origin: origin })).toEqual({
      ok: false,
      reason: "untrusted_origin",
    });
  });

  it("untrusted_origin: an untrusted Referer", () => {
    expect(
      check("POST", { Referer: "https://unregistered.northeasternsga.com/a" }),
    ).toEqual({ ok: false, reason: "untrusted_origin" });
  });
});

type Fields = Record<string, unknown> | undefined;

function setup(
  trustedOrigins: (request: Request) => Promise<readonly string[]> = () =>
    Promise.resolve(TRUSTED),
) {
  const state = {
    calls: 0,
    warns: [] as { msg: string; fields: Fields }[],
    errors: [] as { msg: string; fields: Fields }[],
  };
  const guard = createOriginGuard({
    trustedOrigins: (request) => {
      state.calls += 1;
      return trustedOrigins(request);
    },
    log: {
      warn: (msg, fields) => state.warns.push({ msg, fields }),
      error: (msg, fields) => state.errors.push({ msg, fields }),
    },
  });
  return { guard, state };
}

function post(url: string, headers: Record<string, string>) {
  return new Request(url, { method: "POST", headers });
}

const ADMIN_USERS = `${OWN}/api/sgauth/admin/users`;

describe("createOriginGuard", () => {
  it("lets a safe method and an unenforced path through without loading the registry", async () => {
    const { guard, state } = setup();
    expect(await guard(new Request(ADMIN_USERS))).toBeNull();
    expect(await guard(post(`${OWN}/api/auth/sign-in/email`, {}))).toBeNull();
    expect(state.calls).toBe(0);
    expect(state.warns).toEqual([]);
  });

  it("fails closed when the registry throws", async () => {
    const { guard, state } = setup(() => Promise.reject(new TypeError("boom")));
    const response = await guard(post(ADMIN_USERS, { Origin: PRODUCT }));
    expect(response?.status).toBe(403);
    expect(state.errors).toEqual([
      {
        msg: "Origin check could not load trusted origins",
        fields: { errorName: "TypeError" },
      },
    ]);
    expect(state.warns[0]?.fields?.reason).toBe("registry_error");
  });

  it("AC1: an unregistered origin with a session cookie gets a 403", async () => {
    const { guard, state } = setup();
    const response = await guard(
      post(`${ADMIN_USERS}?token=secret`, {
        Cookie: "__Secure-sgauth.session_token=cookie-secret",
        Origin: "https://unregistered.northeasternsga.com",
      }),
    );

    expect(response?.status).toBe(403);
    expect(await response?.json()).toEqual({
      code: "INVALID_ORIGIN",
      message: "Invalid origin.",
    });
    expect(response?.headers.get("Cache-Control")).toBe("no-store");

    expect(state.warns).toHaveLength(1);
    expect(state.warns[0]?.fields).toEqual({
      reason: "untrusted_origin",
      method: "POST",
      path: "/api/sgauth/admin/users",
      origin: "https://unregistered.northeasternsga.com",
    });
    expect(JSON.stringify(state.warns)).not.toContain("cookie-secret");
    expect(JSON.stringify(state.warns)).not.toContain("secret");
  });

  it("AC2: a registered product origin goes on to the route", async () => {
    const { guard, state } = setup();
    const response = await guard(
      post(ADMIN_USERS, {
        Cookie: "__Secure-sgauth.session_token=x",
        Origin: PRODUCT,
      }),
    );
    expect(response).toBeNull();
    expect(state.warns).toEqual([]);
  });

  it("logs only the origin of a Referer, never its path or query", async () => {
    const { guard, state } = setup();
    await guard(
      post(ADMIN_USERS, {
        Referer: "https://unregistered.northeasternsga.com/p?token=abc",
      }),
    );
    expect(state.warns[0]?.fields?.origin).toBe(
      "https://unregistered.northeasternsga.com",
    );
    expect(JSON.stringify(state.warns)).not.toContain("abc");
  });
});
