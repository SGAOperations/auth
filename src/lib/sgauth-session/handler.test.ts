import { describe, expect, it, vi } from "vitest";
import { APIError } from "better-auth/api";
import { tooManyRequests } from "@/lib/rate-limit/limiter";
import {
  minimalSessionResponseSchema,
  sessionResponseSchema,
} from "@/lib/sgauth-session/contract";
import {
  createSessionEndpoint,
  type SessionEndpointDeps,
} from "@/lib/sgauth-session/handler";
import type { SessionSubject } from "@/lib/sgauth-session/mapping";

const TOKEN = "sgauth.session_token";
const DONT_REMEMBER = "sgauth.dont_remember";
const URL_BASE = "https://auth.example.test/api/sgauth/session";

const subject: SessionSubject = {
  id: "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2b",
  email: "sam@northeastern.edu",
  name: "Sam Example",
  preferredName: null,
  isAdmin: false,
  isPrimaryAdmin: false,
  status: "ACTIVE",
  positions: [{ key: "a-1", name: "A One" }],
};

const sessionRow = {
  id: "0190a1b2-c3d4-7e5f-8a6b-7c8d9e0f1a2c",
  userId: subject.id,
  createdAt: new Date("2026-01-01T00:00:00Z"),
  expiresAt: new Date("2026-01-31T00:00:00Z"),
  absoluteExpiresAt: new Date("2026-04-01T00:00:00Z"),
};

function makeDeps(overrides: Partial<SessionEndpointDeps> = {}) {
  return {
    cookieNames: vi.fn<SessionEndpointDeps["cookieNames"]>(async () => [
      TOKEN,
      DONT_REMEMBER,
    ]),
    getSession: vi.fn<SessionEndpointDeps["getSession"]>(
      overrides.getSession ?? (async () => ({ session: sessionRow })),
    ),
    loadSubject: vi.fn<SessionEndpointDeps["loadSubject"]>(
      overrides.loadSubject ?? (async () => subject),
    ),
    limit: vi.fn<SessionEndpointDeps["limit"]>(
      overrides.limit ?? (async () => null),
    ),
  };
}

function request(cookie?: string, init: RequestInit = {}, url = URL_BASE) {
  const headers = new Headers(init.headers);
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request(url, { ...init, headers });
}

function expectNoDepsCalled(deps: ReturnType<typeof makeDeps>) {
  expect(deps.getSession).not.toHaveBeenCalled();
  expect(deps.loadSubject).not.toHaveBeenCalled();
  expect(deps.limit).not.toHaveBeenCalled();
}

async function expectUnauthenticated(response: Response) {
  expect(response.status).toBe(401);
  expect(await response.json()).toEqual({ error: "unauthenticated" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

describe("session endpoint", () => {
  it("answers 401 without calling anything when there is no cookie", async () => {
    const deps = makeDeps();
    const endpoint = createSessionEndpoint(deps);
    await expectUnauthenticated(await endpoint.full(request()));
    await expectUnauthenticated(await endpoint.minimal(request()));
    expectNoDepsCalled(deps);
  });

  it("ignores the query string, Authorization and foreign cookies", async () => {
    const deps = makeDeps();
    const endpoint = createSessionEndpoint(deps);
    const response = await endpoint.full(
      request(
        "theme=dark",
        { headers: { authorization: "Bearer abc" } },
        `${URL_BASE}?token=abc`,
      ),
    );
    await expectUnauthenticated(response);
    expectNoDepsCalled(deps);
  });

  it("passes Better Auth only the filtered session cookies", async () => {
    const deps = makeDeps();
    const endpoint = createSessionEndpoint(deps);
    await endpoint.full(
      request(`theme=dark; ${TOKEN}=abc; ${DONT_REMEMBER}=true; _ga=1`, {
        headers: { authorization: "Bearer zzz" },
      }),
    );
    const headers = deps.getSession.mock.calls[0][0];
    expect([...headers.entries()]).toEqual([
      ["cookie", `${TOKEN}=abc; ${DONT_REMEMBER}=true`],
    ]);
    expect(deps.limit).toHaveBeenCalledWith("abc");
  });

  it("answers 200 with both headers for the full shape", async () => {
    const endpoint = createSessionEndpoint(makeDeps());
    const response = await endpoint.full(request(`${TOKEN}=abc`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    const body = sessionResponseSchema.parse(await response.json());
    expect(body.user.id).toBe(subject.id);
  });

  it("answers 200 with both headers for the minimal shape", async () => {
    const endpoint = createSessionEndpoint(makeDeps());
    const response = await endpoint.minimal(request(`${TOKEN}=abc`));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(minimalSessionResponseSchema.parse(await response.json())).toEqual({
      user: { id: subject.id },
      positions: subject.positions,
    });
  });

  describe("401 cases", () => {
    it("when getSession finds no session", async () => {
      const endpoint = createSessionEndpoint(
        makeDeps({ getSession: async () => null }),
      );
      await expectUnauthenticated(await endpoint.full(request(`${TOKEN}=a`)));
    });

    it("when the deactivation hook throws UNAUTHORIZED", async () => {
      const endpoint = createSessionEndpoint(
        makeDeps({
          getSession: async () => {
            throw APIError.from("UNAUTHORIZED", {
              code: "ACCOUNT_DEACTIVATED",
              message: "Account deactivated",
            });
          },
        }),
      );
      await expectUnauthenticated(await endpoint.full(request(`${TOKEN}=a`)));
    });

    it("when the user is missing", async () => {
      const endpoint = createSessionEndpoint(
        makeDeps({ loadSubject: async () => null }),
      );
      await expectUnauthenticated(
        await endpoint.minimal(request(`${TOKEN}=a`)),
      );
    });

    it("when the user is deactivated", async () => {
      const endpoint = createSessionEndpoint(
        makeDeps({
          loadSubject: async () => ({ ...subject, status: "DEACTIVATED" }),
        }),
      );
      await expectUnauthenticated(await endpoint.full(request(`${TOKEN}=a`)));
    });
  });

  it("lets an unexpected error propagate so it stays a 5xx", async () => {
    const endpoint = createSessionEndpoint(
      makeDeps({
        getSession: async () => {
          throw new Error("db down");
        },
      }),
    );
    await expect(endpoint.full(request(`${TOKEN}=a`))).rejects.toThrow(
      "db down",
    );
  });

  it("does not turn a non-401 APIError into a 401", async () => {
    const endpoint = createSessionEndpoint(
      makeDeps({
        getSession: async () => {
          throw APIError.from("INTERNAL_SERVER_ERROR", {
            code: "BOOM",
            message: "boom",
          });
        },
      }),
    );
    await expect(endpoint.full(request(`${TOKEN}=a`))).rejects.toBeInstanceOf(
      APIError,
    );
  });

  it("returns the limiter's 429 with the session headers added", async () => {
    const deps = makeDeps({ limit: async () => tooManyRequests(7) });
    const endpoint = createSessionEndpoint(deps);
    const response = await endpoint.full(request(`${TOKEN}=a`));
    expect(response.status).toBe(429);
    expect(response.headers.get("retry-after")).toBe("7");
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    expect(deps.getSession).not.toHaveBeenCalled();
  });
});
