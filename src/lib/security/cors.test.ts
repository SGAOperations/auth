import { describe, expect, it, vi } from "vitest";
import {
  appendVary,
  corsMethodsFor,
  createCors,
  isCorsPreflight,
  matchOrigin,
} from "@/lib/security/cors";

const REGISTERED = "https://vaultz.northeasternsga.com";
const UNREGISTERED = "https://unregistered.northeasternsga.com";
const TRUSTED = ["https://auth.northeasternsga.com", REGISTERED];
const BASE = "https://auth.northeasternsga.com";
const SESSION_PATHS = ["/api/sgauth/session", "/api/sgauth/session/minimal"];

function setup(
  trusted: () => Promise<readonly string[]> = async () => TRUSTED,
) {
  const trustedOrigins = vi.fn(trusted);
  const log = { error: vi.fn() };
  return { ...createCors({ trustedOrigins, log }), trustedOrigins, log };
}

function req(
  method: string,
  path: string,
  headers: Record<string, string> = {},
): Request {
  return new Request(`${BASE}${path}`, { method, headers });
}

function preflightReq(
  path: string,
  origin: string | null,
  method: string | null,
  requestHeaders?: string,
): Request {
  const headers: Record<string, string> = {};
  if (origin) headers.Origin = origin;
  if (method) headers["Access-Control-Request-Method"] = method;
  if (requestHeaders !== undefined) {
    headers["Access-Control-Request-Headers"] = requestHeaders;
  }
  return req("OPTIONS", path, headers);
}

function corsHeaderNames(response: Response): string[] {
  return [...response.headers.keys()].filter((name) =>
    name.startsWith("access-control-"),
  );
}

describe("corsMethodsFor", () => {
  it.each([
    ["/api/sgauth/session", ["GET"]],
    ["/api/sgauth/session/", ["GET"]],
    ["/api/sgauth/session/minimal", ["GET"]],
    ["/api/sgauth/session/minimal/", ["GET"]],
    ["/api/auth/sign-out", ["POST"]],
    ["/api/auth/sign-out/", ["POST"]],
  ])("resolves %s", (path, methods) => {
    expect(corsMethodsFor(path)).toEqual(methods);
  });

  it.each([
    "/api/auth/token",
    "/api/auth/token/",
    "/api/sgauth/session/x",
    "/api/sgauth/session/minimalx",
    "/api/auth/sign-in/email",
    "/api/sgauthx/session",
  ])("returns null for %s", (path) => {
    expect(corsMethodsFor(path)).toBeNull();
  });
});

describe("matchOrigin", () => {
  it("returns the trusted entry", () => {
    expect(matchOrigin(REGISTERED, TRUSTED)).toBe(REGISTERED);
  });

  it.each([
    null,
    "",
    "null",
    "https://VAULTZ.northeasternsga.com",
    "https://vaultz.northeasternsga.com/",
    "https://vaultz.northeasternsga.com:443",
    "http://vaultz.northeasternsga.com",
    "https://vaultz.northeasternsga.com.evil.com",
    "https://evil.vaultz.northeasternsga.com",
    "*",
    "https://x.vercel.app",
  ])("returns null for %j", (origin) => {
    expect(matchOrigin(origin, TRUSTED)).toBeNull();
  });
});

describe("appendVary", () => {
  it.each([
    [null, "Origin"],
    ["Cookie", "Cookie, Origin"],
    ["cookie, origin", "cookie, origin"],
    ["*", "*"],
  ])("merges %j into %j", (existing, expected) => {
    const headers = new Headers();
    if (existing !== null) headers.set("Vary", existing);
    appendVary(headers, "Origin");
    expect(headers.get("Vary")).toBe(expected);
  });
});

describe("isCorsPreflight", () => {
  it("is true for OPTIONS on the three paths", () => {
    for (const path of [...SESSION_PATHS, "/api/auth/sign-out"]) {
      expect(isCorsPreflight("OPTIONS", path)).toBe(true);
      expect(isCorsPreflight("GET", path)).toBe(false);
    }
  });

  it("is false for other paths", () => {
    expect(isCorsPreflight("OPTIONS", "/api/auth/token")).toBe(false);
    expect(isCorsPreflight("OPTIONS", "/api/auth/sign-in/email")).toBe(false);
  });
});

describe("preflight", () => {
  it("allows a registered origin on sign-out with credentials", async () => {
    const { preflight } = setup();
    const res = await preflight(
      preflightReq("/api/auth/sign-out", REGISTERED, "POST", "content-type"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(REGISTERED);
    expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
    expect(res.headers.get("Access-Control-Allow-Methods")).toBe("POST");
    expect(res.headers.get("Access-Control-Allow-Headers")).toBe(
      "Content-Type",
    );
    expect(res.headers.get("Access-Control-Max-Age")).toBe("600");
    expect(res.headers.get("Vary")).toBe(
      "Origin, Access-Control-Request-Method, Access-Control-Request-Headers",
    );
  });

  it("gives an unregistered origin no CORS headers", async () => {
    const { preflight } = setup();
    const res = await preflight(
      preflightReq("/api/auth/sign-out", UNREGISTERED, "POST", "content-type"),
    );
    expect(res.status).toBe(204);
    expect(corsHeaderNames(res)).toEqual([]);
    expect(res.headers.get("Vary")).toContain("Origin");
  });

  describe.each(SESSION_PATHS)("%s", (path) => {
    it("allows GET from a registered origin", async () => {
      const { preflight } = setup();
      const res = await preflight(preflightReq(path, REGISTERED, "GET"));
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(REGISTERED);
      expect(res.headers.get("Access-Control-Allow-Methods")).toBe("GET");
    });

    it("refuses GET from an unregistered origin", async () => {
      const { preflight } = setup();
      const res = await preflight(preflightReq(path, UNREGISTERED, "GET"));
      expect(corsHeaderNames(res)).toEqual([]);
    });

    it("refuses POST from a registered origin", async () => {
      const { preflight } = setup();
      const res = await preflight(preflightReq(path, REGISTERED, "POST"));
      expect(corsHeaderNames(res)).toEqual([]);
    });
  });

  it.each([
    ["DELETE", "content-type"],
    ["post", "content-type"],
    ["POST", "content-type, authorization"],
    ["POST", "x-custom"],
  ])("refuses method %s with headers %s", async (method, requestHeaders) => {
    const { preflight } = setup();
    const res = await preflight(
      preflightReq("/api/auth/sign-out", REGISTERED, method, requestHeaders),
    );
    expect(res.status).toBe(204);
    expect(corsHeaderNames(res)).toEqual([]);
  });

  it("does not CORS-enable /api/auth/token", async () => {
    const { preflight, trustedOrigins } = setup();
    const res = await preflight(
      preflightReq("/api/auth/token", REGISTERED, "GET"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, POST, OPTIONS");
    expect(corsHeaderNames(res)).toEqual([]);
    expect(trustedOrigins).not.toHaveBeenCalled();
  });

  it("does not read the registry without an Origin", async () => {
    const { preflight, trustedOrigins } = setup();
    const res = await preflight(
      preflightReq("/api/auth/sign-out", null, "POST"),
    );
    expect(res.status).toBe(204);
    expect(corsHeaderNames(res)).toEqual([]);
    expect(trustedOrigins).not.toHaveBeenCalled();
  });

  it("answers other auth paths with Allow only", async () => {
    const { preflight, trustedOrigins } = setup();
    const res = await preflight(
      preflightReq("/api/auth/sign-in/email", REGISTERED, "POST"),
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("Allow")).toBe("GET, POST, OPTIONS");
    expect(corsHeaderNames(res)).toEqual([]);
    expect(trustedOrigins).not.toHaveBeenCalled();
  });
});

describe("withCors", () => {
  describe.each(SESSION_PATHS)("%s", (path) => {
    const handler = async () =>
      new Response(JSON.stringify({ error: "unauthenticated" }), {
        status: 401,
        headers: { Vary: "Cookie", "Cache-Control": "no-store" },
      });

    it("decorates a registered origin and keeps the response", async () => {
      const { withCors } = setup();
      const res = await withCors(handler)(
        req("GET", path, { Origin: REGISTERED }),
      );
      expect(res.status).toBe(401);
      expect(await res.json()).toEqual({ error: "unauthenticated" });
      expect(res.headers.get("Vary")).toBe("Cookie, Origin");
      expect(res.headers.get("Cache-Control")).toBe("no-store");
      expect(res.headers.get("Access-Control-Allow-Origin")).toBe(REGISTERED);
      expect(res.headers.get("Access-Control-Allow-Credentials")).toBe("true");
      expect(res.headers.get("Access-Control-Expose-Headers")).toBe(
        "Retry-After",
      );
    });

    it("adds only Vary for an unregistered origin", async () => {
      const { withCors } = setup();
      const res = await withCors(handler)(
        req("GET", path, { Origin: UNREGISTERED }),
      );
      expect(res.headers.get("Vary")).toBe("Cookie, Origin");
      expect(corsHeaderNames(res)).toEqual([]);
    });

    it("adds only Vary with no Origin and skips the registry", async () => {
      const { withCors, trustedOrigins } = setup();
      const res = await withCors(handler)(req("GET", path));
      expect(res.headers.get("Vary")).toBe("Cookie, Origin");
      expect(corsHeaderNames(res)).toEqual([]);
      expect(trustedOrigins).not.toHaveBeenCalled();
    });
  });

  it("keeps every Set-Cookie on sign-out", async () => {
    const { withCors } = setup();
    const res = await withCors(async () => {
      const headers = new Headers();
      headers.append("Set-Cookie", "a=1; Path=/");
      headers.append("Set-Cookie", "b=2; Path=/");
      return new Response(null, { status: 200, headers });
    })(req("POST", "/api/auth/sign-out", { Origin: REGISTERED }));
    expect(res.headers.getSetCookie()).toHaveLength(2);
  });

  it("decorates a response with immutable headers", async () => {
    const { withCors } = setup();
    const res = await withCors(async () =>
      Response.redirect("https://auth.northeasternsga.com/", 302),
    )(req("POST", "/api/auth/sign-out", { Origin: REGISTERED }));
    expect(res.status).toBe(302);
    expect(res.headers.get("Access-Control-Allow-Origin")).toBe(REGISTERED);
  });

  it("returns the same response on a non-CORS path", async () => {
    const { withCors, trustedOrigins } = setup();
    const response = new Response("ok");
    for (const [method, path] of [
      ["POST", "/api/auth/sign-in/email"],
      ["GET", "/api/auth/token"],
    ]) {
      const res = await withCors(async () => response)(
        req(method, path, { Origin: REGISTERED }),
      );
      expect(res).toBe(response);
    }
    expect(trustedOrigins).not.toHaveBeenCalled();
  });

  it("rethrows a handler error", async () => {
    const { withCors } = setup();
    const boom = new Error("boom");
    await expect(
      withCors(async () => {
        throw boom;
      })(req("GET", "/api/sgauth/session", { Origin: REGISTERED })),
    ).rejects.toBe(boom);
  });
});

describe("registry failure", () => {
  it("fails closed and logs only the error name", async () => {
    const { preflight, log } = setup(async () => {
      throw new TypeError("secret detail");
    });
    const res = await preflight(
      preflightReq("/api/auth/sign-out", REGISTERED, "POST", "content-type"),
    );
    expect(corsHeaderNames(res)).toEqual([]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "CORS could not load trusted origins",
      { errorName: "TypeError" },
    );
    expect(JSON.stringify(log.error.mock.calls)).not.toContain("secret detail");
    expect(JSON.stringify(log.error.mock.calls)).not.toContain(REGISTERED);
  });
});
