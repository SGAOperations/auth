import { describe, expect, it, vi } from "vitest";
import {
  countCookie,
  createDuplicateCookieGuard,
  DUPLICATE_COOKIE_GUARDED_PATHS,
  withoutCookie,
} from "@/lib/security/duplicate-cookie";

const NAME = "__Secure-sgauth-dev.session_token";
const DONT_REMEMBER = "__Secure-sgauth-dev.dont_remember";
const BASE = "https://auth.example.test";

describe("countCookie", () => {
  it("counts every pair with the exact name", () => {
    expect(countCookie(null, NAME)).toBe(0);
    expect(countCookie("", NAME)).toBe(0);
    expect(countCookie(`${NAME}=a`, NAME)).toBe(1);
    expect(countCookie(`${NAME}=a; ${NAME}=b`, NAME)).toBe(2);
    expect(countCookie(`${NAME}=a; ${NAME}=`, NAME)).toBe(2);
  });

  it("trims the name and skips chunks with no equals sign", () => {
    expect(countCookie(`${NAME}=a;   ${NAME} =b; junk`, NAME)).toBe(2);
  });

  it("is case-sensitive and does not count near names", () => {
    expect(countCookie(`${NAME.toUpperCase()}=a`, NAME)).toBe(0);
    expect(countCookie("__Secure-sgauth.session_token=a", NAME)).toBe(0);
  });
});

describe("withoutCookie", () => {
  it("removes every copy and keeps the other pairs in order", () => {
    expect(withoutCookie(`a=1; ${NAME}=x;${NAME}=y; b=2`, NAME)).toBe(
      "a=1; b=2",
    );
  });

  it("returns an empty string when nothing is left", () => {
    expect(withoutCookie(`${NAME}=x; ${NAME}=y`, NAME)).toBe("");
  });
});

function setup() {
  const log = { warn: vi.fn() };
  const handler = vi.fn(async (request: Request) => {
    void request;
    return new Response("ok");
  });
  const guarded = createDuplicateCookieGuard({
    cookieName: NAME,
    paths: DUPLICATE_COOKIE_GUARDED_PATHS,
    log,
  })(handler);
  return { log, handler, guarded };
}

function get(path: string, cookie?: string) {
  const headers = new Headers();
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request(`${BASE}${path}`, { headers });
}

describe("duplicate cookie guard", () => {
  it("passes one copy through untouched", async () => {
    const { log, handler, guarded } = setup();
    const request = get("/api/auth/get-session", `${NAME}=a; theme=dark`);
    await guarded(request);
    expect(handler).toHaveBeenCalledWith(request);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("passes no cookie through untouched", async () => {
    const { handler, guarded } = setup();
    const request = get("/api/auth/token");
    await guarded(request);
    expect(handler).toHaveBeenCalledWith(request);
  });

  it("strips both copies of two and logs once", async () => {
    const { log, handler, guarded } = setup();
    await guarded(
      get("/api/auth/get-session", `${NAME}=victim; ${NAME}=planted`),
    );
    const forwarded = handler.mock.calls[0][0];
    expect(forwarded.headers.has("cookie")).toBe(false);
    expect(log.warn).toHaveBeenCalledTimes(1);
    expect(log.warn).toHaveBeenCalledWith("Refused duplicate session cookie", {
      path: "/api/auth/get-session",
      copies: 2,
    });
  });

  it("refuses a different-path copy, sent as a second pair", async () => {
    const { handler, guarded } = setup();
    await guarded(get("/api/auth/token", `${NAME}=specific; ${NAME}=root`));
    expect(handler.mock.calls[0][0].headers.has("cookie")).toBe(false);
  });

  it("handles whitespace around the name", async () => {
    const { handler, guarded } = setup();
    await guarded(get("/api/auth/token", `${NAME}=a;  ${NAME} =b`));
    expect(handler.mock.calls[0][0].headers.has("cookie")).toBe(false);
  });

  it("keeps other cookies after stripping", async () => {
    const { handler, guarded } = setup();
    await guarded(
      get(
        "/api/auth/get-session",
        `theme=dark; ${NAME}=a; ${DONT_REMEMBER}=true; ${NAME}=b; _ga=1`,
      ),
    );
    expect(handler.mock.calls[0][0].headers.get("cookie")).toBe(
      `theme=dark; ${DONT_REMEMBER}=true; _ga=1`,
    );
  });

  it("does not count a near name", async () => {
    const { handler, guarded } = setup();
    const request = get(
      "/api/auth/get-session",
      `__Secure-sgauth.session_token=a; __Secure-sgauth.session_token=b`,
    );
    await guarded(request);
    expect(handler).toHaveBeenCalledWith(request);
  });

  it("ignores a duplicated dont_remember beside one token", async () => {
    const { log, handler, guarded } = setup();
    const request = get(
      "/api/auth/get-session",
      `${NAME}=a; ${DONT_REMEMBER}=true; ${DONT_REMEMBER}=true`,
    );
    await guarded(request);
    expect(handler).toHaveBeenCalledWith(request);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("leaves an unguarded path alone", async () => {
    const { log, handler, guarded } = setup();
    const request = get("/api/auth/sign-out", `${NAME}=a; ${NAME}=b`);
    await guarded(request);
    expect(handler).toHaveBeenCalledWith(request);
    expect(log.warn).not.toHaveBeenCalled();
  });

  it("guards a trailing-slash path", async () => {
    const { handler, guarded } = setup();
    await guarded(get("/api/auth/get-session/", `${NAME}=a; ${NAME}=b`));
    expect(handler.mock.calls[0][0].headers.has("cookie")).toBe(false);
  });

  it("logs neither a token value nor the query string", async () => {
    const { log, guarded } = setup();
    await guarded(
      get("/api/auth/get-session?secret=q", `${NAME}=victim; ${NAME}=planted`),
    );
    expect(JSON.stringify(log.warn.mock.calls)).not.toMatch(
      /victim|planted|secret/,
    );
  });

  it("keeps the request body on a guarded POST", async () => {
    const { handler, guarded } = setup();
    await guarded(
      new Request(`${BASE}/api/auth/get-session`, {
        method: "POST",
        headers: { cookie: `${NAME}=a; ${NAME}=b` },
        body: "payload",
      }),
    );
    const forwarded = handler.mock.calls[0][0];
    expect(forwarded.method).toBe("POST");
    expect(await forwarded.text()).toBe("payload");
  });
});
