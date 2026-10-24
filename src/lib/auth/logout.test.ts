import { describe, expect, it, vi } from "vitest";
import {
  createLogoutHandler,
  createRevokeAllHandler,
  isCrossSiteRequest,
  isPrefetchRequest,
  resolveLogoutRedirect,
} from "@/lib/auth/logout";

const SGAUTH = "https://auth.northeasternsga.com";
const PRODUCT = "https://vaultz.northeasternsga.com";
const LOGIN = `${SGAUTH}/login`;
const EXPIRED =
  "__Secure-sgauth.session_token=; Max-Age=0; Domain=northeasternsga.com; Path=/";

const deps = {
  sgauthOrigin: SGAUTH,
  allowHttpProducts: false,
  isAllowedRedirect: (href: string) => new URL(href).origin === PRODUCT,
};

describe("resolveLogoutRedirect", () => {
  it.each([
    "https://evil.example",
    "//evil.com",
    "/\\evil.com",
    "https://vaultz.northeasternsga.com@evil.com",
    "http://vaultz.northeasternsga.com/",
    "https://unregistered.northeasternsga.com/",
    "javascript:alert(1)",
    `https://vaultz.northeasternsga.com/${"a".repeat(2049)}`,
    "https://vaultz.northeasternsga.com/a b",
    undefined,
    ["https://vaultz.northeasternsga.com/"],
  ])("falls back to /login for %j", async (raw) => {
    expect(await resolveLogoutRedirect(raw, deps)).toBe(LOGIN);
  });

  it("falls back to /login when the registry throws", async () => {
    const isAllowedRedirect = () => {
      throw new Error("registry down");
    };
    expect(
      await resolveLogoutRedirect(`${PRODUCT}/home`, {
        ...deps,
        isAllowedRedirect,
      }),
    ).toBe(LOGIN);
  });

  it("returns a registered product target without its fragment", async () => {
    expect(await resolveLogoutRedirect(`${PRODUCT}/home#x`, deps)).toBe(
      `${PRODUCT}/home`,
    );
  });

  it("keeps a relative target on the SGAuth origin", async () => {
    expect(await resolveLogoutRedirect("/login?x=1", deps)).toBe(
      `${SGAUTH}/login?x=1`,
    );
  });

  it("allows an http product only when configured", async () => {
    const http = "http://vaultz.sga.localhost:3000/home";
    const local = {
      sgauthOrigin: "http://auth.sga.localhost:3000",
      allowHttpProducts: true,
      isAllowedRedirect: () => true,
    };
    expect(await resolveLogoutRedirect(http, local)).toBe(http);
    expect(
      await resolveLogoutRedirect(http, { ...local, allowHttpProducts: false }),
    ).toBe("http://auth.sga.localhost:3000/login");
  });
});

describe("isCrossSiteRequest", () => {
  it.each(["cross-site", " Cross-Site "])("is true for %j", (value) => {
    expect(isCrossSiteRequest(new Headers({ "sec-fetch-site": value }))).toBe(
      true,
    );
  });

  it.each(["same-site", "same-origin", "none"])("is false for %s", (value) => {
    expect(isCrossSiteRequest(new Headers({ "sec-fetch-site": value }))).toBe(
      false,
    );
  });

  it("is false without the header", () => {
    expect(isCrossSiteRequest(new Headers())).toBe(false);
  });
});

describe("isPrefetchRequest", () => {
  it.each<Record<string, string>>([
    { "next-router-prefetch": "1" },
    { purpose: "prefetch" },
    { "sec-purpose": "prefetch;prerender" },
  ])("is true for %j", (headers) => {
    expect(isPrefetchRequest(new Headers(headers))).toBe(true);
  });

  it("is false for a plain request", () => {
    expect(isPrefetchRequest(new Headers())).toBe(false);
  });
});

function logoutHarness(signOut?: () => Promise<{ headers: Headers }>) {
  const calls = vi.fn();
  const log = { warn: vi.fn(), error: vi.fn() };
  const handler = createLogoutHandler({
    ...deps,
    auth: {
      api: {
        signOut:
          signOut ??
          (async () => {
            calls();
            return { headers: new Headers({ "set-cookie": EXPIRED }) };
          }),
      },
    },
    log,
  });
  return { handler, calls, log };
}

const logoutRequest = (headers: Record<string, string>, query = "") =>
  new Request(`${SGAUTH}/logout${query}`, { headers });

describe("createLogoutHandler", () => {
  it("rejects cross-site requests without signing out", async () => {
    const { handler, calls, log } = logoutHarness();
    const res = await handler(
      logoutRequest({ "sec-fetch-site": "cross-site" }, "?redirect=/login"),
    );
    expect(res.status).toBe(403);
    expect(await res.text()).toBe(
      "Sign-out must start from an SGA site. Nothing was changed.",
    );
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(calls).not.toHaveBeenCalled();
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("answers a prefetch with 204 without signing out", async () => {
    const { handler, calls } = logoutHarness();
    const res = await handler(logoutRequest({ "next-router-prefetch": "1" }));
    expect(res.status).toBe(204);
    expect(calls).not.toHaveBeenCalled();
  });

  it("signs out, copies the cookie and refuses an unregistered redirect", async () => {
    const { handler, calls } = logoutHarness();
    const res = await handler(
      logoutRequest(
        { "sec-fetch-site": "same-site" },
        "?redirect=https://evil.example",
      ),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(LOGIN);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.headers.getSetCookie()).toEqual([EXPIRED]);
    expect(calls).toHaveBeenCalledTimes(1);
  });

  it("redirects to a registered product", async () => {
    const { handler } = logoutHarness();
    const res = await handler(
      logoutRequest({}, `?redirect=${encodeURIComponent(`${PRODUCT}/home`)}`),
    );
    expect(res.headers.get("location")).toBe(`${PRODUCT}/home`);
  });

  it("resolves a repeated redirect param through the fallback", async () => {
    const { handler } = logoutHarness();
    const res = await handler(
      logoutRequest({}, "?redirect=https://evil.example&redirect=/login"),
    );
    expect(res.status).toBe(303);
    expect(res.headers.get("location")).toBe(LOGIN);
  });

  it("still redirects when sign-out throws, logging the name only", async () => {
    const { handler, log } = logoutHarness(async () => {
      throw new TypeError("secret detail");
    });
    const res = await handler(
      logoutRequest({}, "?redirect=https://evil.example"),
    );
    expect(res.status).toBe(303);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith("Logout sign-out failed", {
      errorName: "TypeError",
    });
  });

  it("never logs the redirect value", async () => {
    const { handler, log } = logoutHarness();
    await handler(
      logoutRequest(
        { "sec-fetch-site": "cross-site" },
        "?redirect=https://evil.example",
      ),
    );
    await handler(logoutRequest({}, "?redirect=https://evil.example"));
    expect(
      JSON.stringify([log.warn.mock.calls, log.error.mock.calls]),
    ).not.toContain("evil.example");
  });
});

describe("createRevokeAllHandler", () => {
  function harness() {
    const forwarded: Request[] = [];
    const handler = createRevokeAllHandler({
      auth: {
        handler: async (request) => {
          forwarded.push(request);
          return Response.json({ status: true });
        },
      },
    });
    return { handler, forwarded };
  }

  const post = (body?: string) =>
    new Request(`${SGAUTH}/api/sgauth/sessions/revoke-all`, {
      method: "POST",
      headers: {
        cookie: "a=b",
        origin: PRODUCT,
        "x-forwarded-for": "203.0.113.9",
        "content-type": "text/plain",
      },
      body,
    });

  it.each(['{"a":1}', "nope", "[]"])(
    "rejects the body %s without forwarding",
    async (body) => {
      const { handler, forwarded } = harness();
      const res = await handler(post(body));
      expect(res.status).toBe(400);
      expect(await res.json()).toEqual({
        code: "INVALID_BODY",
        message: "Invalid request body.",
      });
      expect(forwarded).toHaveLength(0);
    },
  );

  it.each([undefined, "{}"])(
    "forwards the body %j to /revoke-sessions with the request headers",
    async (body) => {
      const { handler, forwarded } = harness();
      const res = await handler(post(body));
      expect(res.status).toBe(200);
      expect(res.headers.get("cache-control")).toBe("no-store");
      expect(await res.json()).toEqual({ status: true });

      const [request] = forwarded;
      expect(request?.method).toBe("POST");
      expect(new URL(request!.url).pathname).toBe("/api/auth/revoke-sessions");
      expect(request?.headers.get("cookie")).toBe("a=b");
      expect(request?.headers.get("origin")).toBe(PRODUCT);
      expect(request?.headers.get("x-forwarded-for")).toBe("203.0.113.9");
      expect(request?.headers.get("content-type")).toBe("application/json");
    },
  );
});
