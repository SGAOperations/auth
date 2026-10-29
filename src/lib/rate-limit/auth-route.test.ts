import { describe, expect, it, vi } from "vitest";
import { createAuthRouteLimiter } from "@/lib/rate-limit/auth-route";
import {
  createRateLimiter,
  type RateLimitBackend,
} from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";

const SESSION_COOKIE = "__Secure-sgauth.session_token";

function setup(backend: RateLimitBackend = createMemoryBackend()) {
  const log = { error: vi.fn() };
  const limiter = createRateLimiter({ backend, log });
  const stub = vi.fn(async (request: Request) => {
    // Reads the body, to prove the wrapper left it intact.
    const text = await request.text();
    return new Response(text, { status: 200 });
  });
  const handler = createAuthRouteLimiter({
    limiter,
    sessionCookieName: SESSION_COOKIE,
  })(stub);
  return { handler, stub, log };
}

function post(path: string, body?: unknown, headers: HeadersInit = {}) {
  return new Request(`https://auth.test/api/auth${path}`, {
    method: "POST",
    headers: { "x-real-ip": "198.51.100.1", ...headers },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

describe("withAuthRateLimit", () => {
  it("rejects the 11th sign-in from one IP before it reaches Better Auth", async () => {
    const { handler, stub } = setup();
    for (let i = 0; i < 10; i++) {
      const response = await handler(
        post("/sign-in/email", { email: "a@northeastern.edu", password: "x" }),
      );
      expect(response.status).toBe(200);
    }
    const response = await handler(
      post("/sign-in/email", { email: "a@northeastern.edu", password: "x" }),
    );
    expect(response.status).toBe(429);
    expect(Number(response.headers.get("Retry-After"))).toBeGreaterThanOrEqual(
      1,
    );
    expect(stub).toHaveBeenCalledTimes(10);
  });

  it("rejects the 11th passkey sign-in from one IP before it reaches Better Auth", async () => {
    const { handler, stub } = setup();
    for (let i = 0; i < 10; i++) {
      const response = await handler(
        post("/passkey/verify-authentication", { response: {} }),
      );
      expect(response.status).toBe(200);
    }
    const response = await handler(
      post("/passkey/verify-authentication", { response: {} }),
    );
    expect(response.status).toBe(429);
    expect(stub).toHaveBeenCalledTimes(10);
  });

  it("limits passkey options at 30 a minute, for any method", async () => {
    const { handler, stub } = setup();
    const options = (method: string) =>
      new Request(
        "https://auth.test/api/auth/passkey/generate-authenticate-options",
        {
          method,
          headers: { "x-real-ip": "198.51.100.1" },
        },
      );
    for (let i = 0; i < 30; i++) {
      const method = i % 2 === 0 ? "GET" : "POST";
      expect((await handler(options(method))).status).toBe(200);
    }
    expect((await handler(options("GET"))).status).toBe(429);
    expect(stub).toHaveBeenCalledTimes(30);
  });

  it("limits sign-up at 5 an hour", async () => {
    const { handler } = setup();
    for (let i = 0; i < 5; i++) {
      expect((await handler(post("/sign-up/email", {}))).status).toBe(200);
    }
    expect((await handler(post("/sign-up/email", {}))).status).toBe(429);
  });

  it("limits a reset by email across IPs, with a trailing slash too", async () => {
    const { handler } = setup();
    for (let i = 0; i < 3; i++) {
      const response = await handler(
        post(
          "/request-password-reset/",
          { email: "Victim@northeastern.edu" },
          { "x-real-ip": `198.51.100.${i + 10}` },
        ),
      );
      expect(response.status).toBe(200);
    }
    const blocked = await handler(
      post(
        "/request-password-reset",
        { email: "victim@northeastern.edu" },
        { "x-real-ip": "198.51.100.99" },
      ),
    );
    expect(blocked.status).toBe(429);
  });

  it("limits a verification resend with no body by IP", async () => {
    const { handler } = setup();
    for (let i = 0; i < 3; i++) {
      expect((await handler(post("/send-verification-email"))).status).toBe(
        200,
      );
    }
    expect((await handler(post("/send-verification-email"))).status).toBe(429);
  });

  it("limits the token endpoint per session cookie", async () => {
    const { handler } = setup();
    const request = (cookie: string) =>
      new Request("https://auth.test/api/auth/token", {
        headers: { "x-real-ip": "198.51.100.1", cookie },
      });
    for (let i = 0; i < 60; i++) {
      expect((await handler(request(`${SESSION_COOKIE}=one`))).status).toBe(
        200,
      );
    }
    expect((await handler(request(`${SESSION_COOKIE}=one`))).status).toBe(429);
    expect((await handler(request(`${SESSION_COOKIE}=two`))).status).toBe(200);
  });

  it("never touches the backend for the session endpoint", async () => {
    const limit = vi.fn();
    const { handler, stub } = setup({ limit });
    for (let i = 0; i < 500; i++) {
      const response = await handler(
        new Request("https://auth.test/api/auth/get-session", {
          headers: { "x-real-ip": "198.51.100.1" },
        }),
      );
      expect(response.status).toBe(200);
    }
    expect(limit).not.toHaveBeenCalled();
    expect(stub).toHaveBeenCalledTimes(500);
  });

  it("leaves the body readable after parsing the email", async () => {
    const { handler } = setup();
    const response = await handler(
      post("/request-password-reset", { email: "a@northeastern.edu" }),
    );
    expect(await response.json()).toEqual({ email: "a@northeastern.edu" });
  });

  it("still signs in when the backend is down, and raises an alert", async () => {
    const { handler, stub, log } = setup({
      limit: async () => {
        throw new Error("upstash unreachable");
      },
    });
    const response = await handler(
      post("/sign-in/email", { email: "a@northeastern.edu", password: "x" }),
    );
    expect(response.status).toBe(200);
    expect(stub).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(
      "[ALERT] rate-limit fail-open",
      expect.objectContaining({ policy: "signIn" }),
    );
  });
});
