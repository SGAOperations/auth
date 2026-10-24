import { beforeAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { prisma } from "@/lib/prisma";
import { buildAuthOptions } from "@/lib/auth/options";
import { createRateLimiter } from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import {
  minimalSessionResponseSchema,
  sessionResponseSchema,
  unauthenticatedResponseSchema,
} from "@/lib/sgauth-session/contract";
import {
  buildSessionEndpointDeps,
  createSessionEndpoint,
} from "@/lib/sgauth-session/handler";
import { createPosition, createUser } from "@/test/factories";
import { useFakeClock } from "@/test/fake-clock";

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const ENDPOINT_URL = `${BASE_URL}/api/sgauth/session`;
const PASSWORD = "correct-horse-battery-staple";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

const FORBIDDEN_KEY = /password|token|secret|backup|hash|ip|agent/i;

// The real Better Auth options, so the real hooks run (as audit-hooks.db.test.ts).
const auth = betterAuth(
  buildAuthOptions({ prisma, baseURL: BASE_URL, secret: SECRET }),
);
const endpoint = createSessionEndpoint(
  buildSessionEndpointDeps({
    auth,
    prisma,
    limiter: createRateLimiter({
      backend: createMemoryBackend(),
      log: { error: () => undefined },
    }),
  }),
);

function sessionRequest(
  cookie?: string,
  url = ENDPOINT_URL,
  init: RequestInit = {},
) {
  const headers = new Headers(init.headers);
  if (cookie !== undefined) headers.set("cookie", cookie);
  return new Request(url, { ...init, headers });
}

function call(cookie?: string) {
  return endpoint.full(sessionRequest(cookie));
}

async function signIn(email: string): Promise<string> {
  const result = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    returnHeaders: true,
  });
  return result.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
}

async function signedInUser(overrides: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser({ password: PASSWORD, ...overrides });
  const cookie = await signIn(user.email);
  return { user, cookie };
}

async function expectUnauthenticated(response: Response) {
  expect(response.status).toBe(401);
  const body = unauthenticatedResponseSchema.parse(await response.json());
  expect(body).toEqual({ error: "unauthenticated" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(response.headers.get("vary")).toBe("Cookie");
}

function walk(
  node: unknown,
  visit: (key: string | null, value: unknown) => void,
) {
  if (Array.isArray(node)) {
    for (const item of node) walk(item, visit);
  } else if (node && typeof node === "object") {
    for (const [key, value] of Object.entries(node)) {
      visit(key, value);
      walk(value, visit);
    }
  } else {
    visit(null, node);
  }
}

describe("GET /api/sgauth/session against the database", () => {
  let tokenCookieName: string;

  beforeAll(async () => {
    tokenCookieName = (await auth.$context).authCookies.sessionToken.name;
  });

  it("returns the 200 shape from the database rows", async () => {
    const { user, cookie } = await signedInUser({ preferredName: "Sam" });
    const row = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });

    const response = await call(cookie);
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");

    const body = sessionResponseSchema.parse(await response.json());
    expect(body.user).toEqual({
      id: user.id,
      email: user.email,
      name: user.name,
      preferredName: "Sam",
      isAdmin: false,
      isPrimaryAdmin: false,
    });
    expect(body.session.id).toBe(row.id);
    expect(
      Date.parse(body.session.absoluteExpiresAt) -
        Date.parse(body.session.createdAt),
    ).toBe(90 * DAY_MS);
  });

  it("never leaks a token, a password hash or an MFA secret", async () => {
    const { user, cookie } = await signedInUser();
    const row = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    const account = await prisma.account.findFirstOrThrow({
      where: { userId: user.id },
    });
    const secret = "JBSWY3DPEHPK3PXP-seeded-mfa-secret";
    await prisma.twoFactor.create({
      data: { userId: user.id, secret, backupCodes: "seeded-backup-codes" },
    });

    for (const respond of [
      call,
      (c: string) => endpoint.minimal(sessionRequest(c)),
    ]) {
      const body: unknown = await (await respond(cookie)).json();
      const values: string[] = [];
      walk(body, (key, value) => {
        if (key !== null) expect(key).not.toMatch(FORBIDDEN_KEY);
        if (typeof value === "string") values.push(value);
      });
      for (const value of values) {
        expect(value).not.toBe(row.token);
        expect(value).not.toBe(account.password);
        expect(value).not.toBe(secret);
      }
      expect(JSON.stringify(body)).not.toContain(row.token);
    }
  });

  it("lists active positions sorted by key in code-unit order", async () => {
    const { user, cookie } = await signedInUser();
    const empty = sessionResponseSchema.parse(
      await (await call(cookie)).json(),
    );
    expect(empty.positions).toEqual([]);

    const holders = [
      await createPosition({ key: "vpa", name: "VPA" }),
      await createPosition({
        key: "vp-finance",
        name: "Vice President of Finance",
      }),
      await createPosition({ key: "a-1", name: "A One" }),
      await createPosition({
        key: "zz-gone",
        name: "Gone",
        deletedAt: new Date(),
      }),
    ];
    await prisma.userPosition.createMany({
      data: holders.map((position) => ({
        userId: user.id,
        positionId: position.id,
      })),
    });

    const body = sessionResponseSchema.parse(await (await call(cookie)).json());
    expect(body.positions).toEqual([
      { key: "a-1", name: "A One" },
      { key: "vp-finance", name: "Vice President of Finance" },
      { key: "vpa", name: "VPA" },
    ]);
  });

  it("answers the minimal shape with the same user id and positions", async () => {
    const { user, cookie } = await signedInUser();
    const position = await createPosition();
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: position.id },
    });

    const full = sessionResponseSchema.parse(await (await call(cookie)).json());
    const response = await endpoint.minimal(sessionRequest(cookie));
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("vary")).toBe("Cookie");
    const minimal = minimalSessionResponseSchema.parse(await response.json());
    expect(minimal.user.id).toBe(full.user.id);
    expect(minimal.positions).toEqual(full.positions);
    expect(minimal.positions).toEqual([
      { key: position.key, name: position.name },
    ]);
  });

  it("reflects position and admin changes on the very next call", async () => {
    const { user, cookie } = await signedInUser();
    const position = await createPosition();

    await prisma.userPosition.create({
      data: { userId: user.id, positionId: position.id },
    });
    let body = sessionResponseSchema.parse(await (await call(cookie)).json());
    expect(body.positions.map((p) => p.key)).toEqual([position.key]);

    await prisma.userPosition.delete({
      where: {
        userId_positionId: { userId: user.id, positionId: position.id },
      },
    });
    body = sessionResponseSchema.parse(await (await call(cookie)).json());
    expect(body.positions).toEqual([]);

    await prisma.user.update({
      where: { id: user.id },
      data: { isAdmin: true },
    });
    body = sessionResponseSchema.parse(await (await call(cookie)).json());
    expect(body.user.isAdmin).toBe(true);
  });

  describe("answers 401", () => {
    it("with no cookie", async () => {
      await expectUnauthenticated(await call());
    });

    it("with a tampered cookie value", async () => {
      const { cookie } = await signedInUser();
      const separator = cookie.indexOf("=");
      const value = cookie.slice(separator + 1);
      const tampered = `${cookie.slice(0, separator + 1)}${value[0] === "x" ? "y" : "x"}${value.slice(1)}`;
      await expectUnauthenticated(await call(tampered));
    });

    it("with only a foreign cookie", async () => {
      await signedInUser();
      await expectUnauthenticated(await call("theme=dark"));
    });

    it("with the right value under a different name", async () => {
      const { cookie } = await signedInUser();
      await expectUnauthenticated(
        await call(cookie.replace(tokenCookieName, "other.session_token")),
      );
    });

    it("on the very next call after the session is revoked", async () => {
      const { user, cookie } = await signedInUser();
      expect((await call(cookie)).status).toBe(200);
      const row = await prisma.session.findFirstOrThrow({
        where: { userId: user.id },
      });

      const revoked = await auth.handler(
        new Request(`${BASE_URL}/api/auth/revoke-session`, {
          method: "POST",
          headers: {
            "content-type": "application/json",
            origin: BASE_URL,
            cookie,
          },
          body: JSON.stringify({ token: row.token }),
        }),
      );
      expect(revoked.status).toBe(200);
      await expectUnauthenticated(await call(cookie));
    });

    it("on the very next call after the session row is deleted", async () => {
      const { user, cookie } = await signedInUser();
      expect((await call(cookie)).status).toBe(200);
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await expectUnauthenticated(await call(cookie));
    });

    it("on the very next call after the user is deactivated", async () => {
      const { user, cookie } = await signedInUser();
      expect((await call(cookie)).status).toBe(200);
      await prisma.user.update({
        where: { id: user.id },
        data: { status: "DEACTIVATED" },
      });
      await expectUnauthenticated(await call(cookie));
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
        0,
      );
    });

    it("after 31 idle days", async () => {
      const clock = useFakeClock(new Date());
      const { cookie } = await signedInUser();
      clock.advance(31 * DAY_MS);
      await expectUnauthenticated(await call(cookie));
    });

    it("at the 90-day absolute cap, though the session is used daily", async () => {
      const clock = useFakeClock(new Date());
      const { cookie } = await signedInUser();
      const start = clock.now().getTime();

      for (let day = 1; day <= 89; day++) {
        clock.set(new Date(start + day * DAY_MS + HOUR_MS));
        expect((await call(cookie)).status).toBe(200);
      }

      clock.set(new Date(start + 90 * DAY_MS + HOUR_MS));
      await expectUnauthenticated(await call(cookie));
    }, 300_000);
  });

  describe("accepts the cookie header only", () => {
    it("ignores a token in the query string", async () => {
      const { user } = await signedInUser();
      const row = await prisma.session.findFirstOrThrow({
        where: { userId: user.id },
      });
      const response = await endpoint.full(
        sessionRequest(undefined, `${ENDPOINT_URL}?token=${row.token}`),
      );
      await expectUnauthenticated(response);
    });

    it("ignores an Authorization header", async () => {
      const { cookie } = await signedInUser();
      const value = cookie.slice(cookie.indexOf("=") + 1);
      const response = await endpoint.full(
        sessionRequest(undefined, ENDPOINT_URL, {
          headers: { authorization: `Bearer ${value}` },
        }),
      );
      await expectUnauthenticated(response);
    });
  });
});
