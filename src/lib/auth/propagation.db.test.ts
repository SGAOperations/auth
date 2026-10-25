import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createLocalJWKSet, errors, jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";
import { buildAuthOptions } from "@/lib/auth/options";
import { testLockout } from "@/test/lockout-options";
import { buildJwtPlugin } from "@/lib/auth/jwt";
import { JWT_AUDIENCE, JWT_EXPIRATION } from "@/lib/auth/jwt-constants";
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

// Position changes reach products two ways: the session endpoint reads the
// database on every call, and a JWT carries the positions it was minted with
// until it expires. These tests pin both, plus what a force re-login does to
// each. "Force re-login" is the admin action that deletes every session of a
// user; it is exercised here at the Better Auth layer, which is what it runs.

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";
const MAX_TOKEN_LIFETIME_SECONDS = 600;

// The live plugin list minus nextCookies, which needs a Next.js request scope.
const auth = betterAuth({
  ...buildAuthOptions({
    prisma,
    baseURL: BASE_URL,
    secret: SECRET,
    lockout: testLockout(),
  }),
  plugins: [buildJwtPlugin({ prisma, issuer: BASE_URL })],
});
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

function sessionRequest(cookie: string, path: "session" | "session/minimal") {
  return new Request(`${BASE_URL}/api/sgauth/${path}`, {
    headers: { cookie },
  });
}

async function fullPositionKeys(cookie: string): Promise<string[]> {
  const response = await endpoint.full(sessionRequest(cookie, "session"));
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return sessionResponseSchema
    .parse(await response.json())
    .positions.map((position) => position.key);
}

async function minimalPositionKeys(cookie: string): Promise<string[]> {
  const response = await endpoint.minimal(
    sessionRequest(cookie, "session/minimal"),
  );
  expect(response.status).toBe(200);
  expect(response.headers.get("cache-control")).toBe("no-store");
  return minimalSessionResponseSchema
    .parse(await response.json())
    .positions.map((position) => position.key);
}

/** Both endpoints, one call each, must show the same keys. */
async function expectPositionKeys(cookie: string, keys: string[]) {
  expect(await fullPositionKeys(cookie)).toEqual(keys);
  expect(await minimalPositionKeys(cookie)).toEqual(keys);
}

async function expectUnauthenticated(cookie: string) {
  for (const [handler, path] of [
    [endpoint.full, "session"],
    [endpoint.minimal, "session/minimal"],
  ] as const) {
    const response = await handler(sessionRequest(cookie, path));
    expect(response.status).toBe(401);
    expect(unauthenticatedResponseSchema.parse(await response.json())).toEqual({
      error: "unauthenticated",
    });
  }
}

async function mint(cookie: string): Promise<string> {
  const { token } = await auth.api.getToken({
    headers: new Headers({ cookie }),
  });
  return token;
}

async function verify(token: string, currentDate?: Date) {
  const jwks = createLocalJWKSet(await auth.api.getJwks());
  const { payload } = await jwtVerify(token, jwks, {
    issuer: BASE_URL,
    audience: JWT_AUDIENCE,
    currentDate,
  });
  return payload;
}

const assign = (userId: string, positionId: string) =>
  prisma.userPosition.create({ data: { userId, positionId } });

const unassign = (userId: string, positionId: string) =>
  prisma.userPosition.delete({
    where: { userId_positionId: { userId, positionId } },
  });

const softDelete = (positionId: string) =>
  prisma.position.update({
    where: { id: positionId },
    data: { deletedAt: new Date() },
  });

async function forceReLogin(userId: string) {
  await (await auth.$context).internalAdapter.deleteUserSessions(userId);
}

async function signedInUser() {
  const user = await createUser({ password: PASSWORD });
  return { user, cookie: await signIn(user.email) };
}

describe("position changes on the session endpoint", () => {
  it("show on the very next call after an assign, unassign or delete", async () => {
    const { user, cookie } = await signedInUser();
    const early = await createPosition({ key: "t45-b-early" });
    const late = await createPosition({ key: "t45-a-late" });

    await expectPositionKeys(cookie, []);

    await assign(user.id, early.id);
    await assign(user.id, late.id);
    await expectPositionKeys(cookie, ["t45-a-late", "t45-b-early"]);
    const full = sessionResponseSchema.parse(
      await (await endpoint.full(sessionRequest(cookie, "session"))).json(),
    );
    expect(full.positions).toEqual([
      { key: late.key, name: late.name },
      { key: early.key, name: early.name },
    ]);

    await unassign(user.id, early.id);
    await expectPositionKeys(cookie, ["t45-a-late"]);

    // The UserPosition row survives a soft delete; the position must still go.
    await softDelete(late.id);
    expect(
      await prisma.userPosition.count({ where: { userId: user.id } }),
    ).toBe(1);
    await expectPositionKeys(cookie, []);
  });

  it("is a 401 on the very next call after a force re-login", async () => {
    const { user, cookie } = await signedInUser();
    await expectPositionKeys(cookie, []);

    await forceReLogin(user.id);
    await expectUnauthenticated(cookie);
  });

  it("does not let a new sign-in reuse the revoked cookie", async () => {
    const { user, cookie } = await signedInUser();
    await forceReLogin(user.id);

    const fresh = await signIn(user.email);
    expect(fresh).not.toBe(cookie);
    await expectPositionKeys(fresh, []);
    await expectUnauthenticated(cookie);
  });
});

describe("position changes in a JWT", () => {
  it("never outlive the token, and a new token shows them at once", async () => {
    const { user, cookie } = await signedInUser();
    const position = await createPosition({ key: "t45-held" });
    await assign(user.id, position.id);

    const before = await mint(cookie);
    const stale = await verify(before);
    expect(stale.positions).toEqual(["t45-held"]);
    const lifetime = (stale.exp ?? 0) - (stale.iat ?? 0);
    expect(lifetime).toBeGreaterThan(0);
    expect(lifetime).toBeLessThanOrEqual(MAX_TOKEN_LIFETIME_SECONDS);
    expect(JWT_EXPIRATION).toBe("10m");

    await unassign(user.id, position.id);

    // Still valid, still carrying the position it no longer holds.
    expect((await verify(before)).positions).toEqual(["t45-held"]);
    expect((await verify(await mint(cookie))).positions).toEqual([]);

    // The staleness window closes at exp.
    const afterExpiry = new Date(((stale.exp ?? 0) + 1) * 1000);
    await expect(verify(before, afterExpiry)).rejects.toBeInstanceOf(
      errors.JWTExpired,
    );
  });

  it("stop new tokens after a force re-login but leave issued ones to expire", async () => {
    const { user, cookie } = await signedInUser();
    const issued = await mint(cookie);
    const claims = await verify(issued);

    await forceReLogin(user.id);

    await expect(mint(cookie)).rejects.toMatchObject({ statusCode: 401 });
    // Revocation does not recall an issued JWT: it verifies until exp.
    expect((await verify(issued)).sub).toBe(user.id);
    await expect(
      verify(issued, new Date(((claims.exp ?? 0) + 1) * 1000)),
    ).rejects.toBeInstanceOf(errors.JWTExpired);
  });
});
