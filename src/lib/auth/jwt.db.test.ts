import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildJwtPlugin } from "@/lib/auth/jwt";
import { createPosition, createUser } from "@/test/factories";

const ISSUER = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";

// The live plugin list minus nextCookies, which needs a Next.js request scope.
const auth = betterAuth({
  ...buildAuthOptions({
    prisma,
    baseURL: ISSUER,
    secret: "s".repeat(32),
  }),
  plugins: [buildJwtPlugin({ prisma, issuer: ISSUER })],
});

async function signIn(email: string) {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  const cookie = response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
  return new Headers({ cookie });
}

async function assign(userId: string, positionId: string) {
  await prisma.userPosition.create({ data: { userId, positionId } });
}

describe("GET /token", () => {
  it("returns an ES256 token that verifies against the JWKS", async () => {
    const user = await createUser({ password: PASSWORD });
    const second = await createPosition({ key: `b-second-${user.id}` });
    const first = await createPosition({ key: `a-first-${user.id}` });
    const retired = await createPosition({
      key: `c-retired-${user.id}`,
      deletedAt: new Date(),
    });
    await assign(user.id, second.id);
    await assign(user.id, first.id);
    await assign(user.id, retired.id);

    const { token } = await auth.api.getToken({
      headers: await signIn(user.email),
    });
    const jwks = await auth.api.getJwks();
    const { payload, protectedHeader } = await jwtVerify(
      token,
      createLocalJWKSet(jwks),
      { issuer: ISSUER, audience: "authenticated" },
    );

    expect(payload.sub).toBe(user.id);
    expect(payload).toMatchObject({
      email: user.email,
      role: "authenticated",
      positions: [`a-first-${user.id}`, `b-second-${user.id}`],
      is_admin: false,
      is_primary_admin: false,
    });
    expect((payload.exp ?? 0) - (payload.iat ?? 0)).toBe(600);
    expect(protectedHeader.alg).toBe("ES256");
    expect(jwks.keys.map((key) => key.kid)).toContain(protectedHeader.kid);
  });

  it("reads the admin flags fresh from the database", async () => {
    const user = await createUser({ password: PASSWORD, isAdmin: true });
    const { token } = await auth.api.getToken({
      headers: await signIn(user.email),
    });
    const { payload } = await jwtVerify(
      token,
      createLocalJWKSet(await auth.api.getJwks()),
      { issuer: ISSUER },
    );
    expect(payload.is_admin).toBe(true);
    expect(payload.is_primary_admin).toBe(false);
  });

  it("refuses a user who was deactivated after signing in", async () => {
    const user = await createUser({ password: PASSWORD });
    const headers = await signIn(user.email);
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DEACTIVATED" },
    });

    await expect(auth.api.getToken({ headers })).rejects.toMatchObject({
      statusCode: 401,
    });
  });

  it("refuses a request with no session cookie", async () => {
    await expect(
      auth.api.getToken({ headers: new Headers() }),
    ).rejects.toMatchObject({ statusCode: 401 });
  });

  it("does not put a token on /get-session", async () => {
    const user = await createUser({ password: PASSWORD });
    const response = await auth.api.getSession({
      headers: await signIn(user.email),
      asResponse: true,
    });
    expect(response.headers.get("set-auth-jwt")).toBeNull();
  });

  it("names the key that signed in the JWKS", async () => {
    const user = await createUser({ password: PASSWORD });
    const { token } = await auth.api.getToken({
      headers: await signIn(user.email),
    });
    const { kid } = decodeProtectedHeader(token);
    const row = await prisma.jwks.findUniqueOrThrow({
      where: { id: String(kid) },
    });
    expect(row.alg).toBe("ES256");
    expect(row.expiresAt).toBeNull();
  });
});
