import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import {
  createRemoteJWKSet,
  customFetch,
  decodeProtectedHeader,
  errors,
  jwtVerify,
  type JWTPayload,
} from "jose";
import nextConfig from "../../../next.config";
import { prisma } from "@/lib/prisma";
import { buildAuthOptions } from "@/lib/auth/options";
import { testLockout } from "@/test/lockout-options";
import { buildJwtPlugin, buildOpenIdConfiguration } from "@/lib/auth/jwt";
import {
  activateStagedKey,
  stageKey,
} from "../../../prisma/seed/jwks-rotation";
import { createUser } from "@/test/factories";

// Conformance suite for what Supabase third-party auth requires of a token and
// of the key set behind it. The checklist in docs/integration/supabase-products.md
// names each requirement and the test title that proves it: keep the two in step.
//
// Everything goes through the real plugin options and Better Auth's own request
// handler, with jose's remote key set fetching in-process, so no server runs.

const ISSUER = "http://localhost:3000";
const PASSWORD = "correct-horse-battery-staple";
const SECRET = "s".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

// The live plugin list minus nextCookies, which needs a Next.js request scope.
const auth = betterAuth({
  ...buildAuthOptions({
    prisma,
    baseURL: ISSUER,
    secret: SECRET,
    lockout: testLockout(),
  }),
  plugins: [buildJwtPlugin({ prisma, issuer: ISSUER })],
});

const discovery = buildOpenIdConfiguration(ISSUER);

/** Serves only the issuer's own paths, in process. Anything else throws. */
async function localFetch(url: string, init?: RequestInit): Promise<Response> {
  const parsed = new URL(url);
  if (parsed.origin !== ISSUER) {
    throw new Error(`Refusing a request outside the issuer: ${url}`);
  }
  if (parsed.pathname === "/.well-known/jwks.json") {
    return auth.handler(
      new Request(new URL(new URL(discovery.jwks_uri).pathname, ISSUER)),
    );
  }
  if (parsed.pathname.startsWith("/api/auth/")) {
    return auth.handler(new Request(url, init));
  }
  throw new Error(`No in-process handler for ${url}`);
}

/** A fresh key set every call: jose caches keys per instance. */
const remoteKeys = () =>
  createRemoteJWKSet(new URL(discovery.jwks_uri), {
    [customFetch]: (url, options) => localFetch(url, options as RequestInit),
  });

async function signIn(email: string) {
  const response = await auth.api.signInEmail({
    body: { email, password: PASSWORD },
    asResponse: true,
  });
  return response.headers
    .getSetCookie()
    .map((entry) => entry.split(";")[0])
    .join("; ");
}

const tokenRequest = (cookie?: string) =>
  localFetch(`${ISSUER}/api/auth/token`, {
    headers: cookie ? { cookie } : {},
  });

async function mintToken(cookie: string): Promise<string> {
  const response = await tokenRequest(cookie);
  expect(response.status).toBe(200);
  return ((await response.json()) as { token: string }).token;
}

async function verify(token: string) {
  return jwtVerify(token, remoteKeys(), {
    issuer: ISSUER,
    audience: "authenticated",
    algorithms: ["ES256"],
  });
}

async function publishedKeys() {
  const response = await localFetch(discovery.jwks_uri);
  expect(response.status).toBe(200);
  return ((await response.json()) as { keys: Record<string, unknown>[] }).keys;
}

async function newSession() {
  const user = await createUser({ password: PASSWORD });
  return { user, cookie: await signIn(user.email) };
}

describe("OIDC discovery document", () => {
  it("names an issuer that is a bare origin, a jwks_uri under it, and ES256", () => {
    for (const issuer of [ISSUER, "https://auth.northeasternsga.com"]) {
      const document = buildOpenIdConfiguration(issuer);
      expect(document.issuer).toBe(issuer);
      expect(document.issuer.endsWith("/")).toBe(false);
      expect(document.jwks_uri.startsWith(`${issuer}/`)).toBe(true);
      expect(document.id_token_signing_alg_values_supported).toEqual(["ES256"]);
      expect(document.subject_types_supported).toEqual(["public"]);
    }
  });

  it("is served at the well-known path, and the key set at jwks.json", async () => {
    const rewrites = (await nextConfig.rewrites?.()) as {
      source: string;
      destination: string;
    }[];
    expect(rewrites).toContainEqual({
      source: "/.well-known/openid-configuration",
      destination: "/api/sgauth/openid-configuration",
    });
    expect(rewrites).toContainEqual({
      source: "/.well-known/jwks.json",
      destination: "/api/sgauth/jwks",
    });
  });

  it("points jwks_uri at a key set that answers with keys", async () => {
    await mintToken((await newSession()).cookie);
    expect((await publishedKeys()).length).toBeGreaterThan(0);

    const wellKnown = await localFetch(`${ISSUER}/.well-known/jwks.json`);
    expect(wellKnown.status).toBe(200);
    expect(((await wellKnown.json()) as { keys: unknown[] }).keys).not.toEqual(
      [],
    );
  });
});

describe("JWKS", () => {
  it("publishes public ES256 P-256 keys only, each with a unique kid", async () => {
    await mintToken((await newSession()).cookie);
    const keys = await publishedKeys();
    expect(keys.length).toBeGreaterThan(0);
    for (const key of keys) {
      expect(key).toMatchObject({ kty: "EC", crv: "P-256", alg: "ES256" });
      expect(String(key.kid)).not.toBe("");
      expect(key.x).toEqual(expect.any(String));
      expect(key.y).toEqual(expect.any(String));
      expect(key).not.toHaveProperty("d");
    }
    expect(new Set(keys.map((key) => key.kid)).size).toBe(keys.length);
  });
});

describe("GET /token", () => {
  it("verifies through the remote JWKS, with an ES256 header that names a published kid", async () => {
    const { cookie } = await newSession();
    const token = await mintToken(cookie);

    const { protectedHeader } = await verify(token);
    expect(protectedHeader.alg).toBe("ES256");
    expect(protectedHeader.kid).toEqual(expect.any(String));
    expect((await publishedKeys()).map((key) => key.kid)).toContain(
      protectedHeader.kid,
    );
  });

  it("carries the claims Supabase reads", async () => {
    const { user, cookie } = await newSession();
    const { payload } = await verify(await mintToken(cookie));

    expect(payload.sub).toBe(user.id);
    expect(payload.sub).toMatch(UUID);
    expect(payload.role).toBe("authenticated");
    expect(payload.iss).toBe(discovery.issuer);
    expect([payload.aud].flat()).toContain("authenticated");
    const { exp, iat } = payload as Required<JWTPayload>;
    expect(Number.isInteger(exp)).toBe(true);
    expect(Number.isInteger(iat)).toBe(true);
    expect(exp - iat).toBeGreaterThan(0);
    expect(exp - iat).toBeLessThanOrEqual(600);
  });

  describe("requires a live session", () => {
    const refused = async (response: Response) => {
      expect(response.status).toBe(401);
      expect(await response.text()).not.toContain('"token"');
    };

    it("refuses a request with no cookie", async () => {
      await refused(await tokenRequest());
    });

    it("refuses a cookie with a tampered signature", async () => {
      const { cookie } = await newSession();
      const tampered = cookie
        .split("; ")
        .map((entry) => {
          const [name, ...rest] = entry.split("=");
          if (!name.endsWith("session_token")) return entry;
          const value = rest.join("=");
          return `${name}=${value[0] === "A" ? "B" : "A"}${value.slice(1)}`;
        })
        .join("; ");
      expect(tampered).not.toBe(cookie);
      await refused(await tokenRequest(tampered));
    });

    it("refuses a session that was revoked", async () => {
      const { user, cookie } = await newSession();
      await mintToken(cookie);
      await prisma.session.deleteMany({ where: { userId: user.id } });
      await refused(await tokenRequest(cookie));
    });

    it("refuses a session that has expired", async () => {
      const { user, cookie } = await newSession();
      await mintToken(cookie);
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { expiresAt: new Date(Date.now() - 60_000) },
      });
      await refused(await tokenRequest(cookie));
    });
  });
});

describe("key rotation", () => {
  it("keeps the retired key published for 7 days, then drops it", async () => {
    const { cookie } = await newSession();
    const tokenA = await mintToken(cookie);
    const kidA = String(decodeProtectedHeader(tokenA).kid);

    // The runbook's two steps: stage a key, then activate it.
    const kidB = await stageKey(prisma, SECRET, new Date());
    await activateStagedKey(prisma, new Date());

    const kids = async () => (await publishedKeys()).map((key) => key.kid);
    expect(await kids()).toEqual(expect.arrayContaining([kidA, kidB]));
    await verify(tokenA);
    expect(decodeProtectedHeader(await mintToken(cookie)).kid).toBe(kidB);

    const retiredAt = async (msAgo: number) =>
      prisma.jwks.update({
        where: { id: kidA },
        data: { expiresAt: new Date(Date.now() - msAgo) },
      });

    await retiredAt(7 * DAY_MS - 60 * 60_000);
    expect(await kids()).toContain(kidA);
    await verify(tokenA);

    await retiredAt(7 * DAY_MS + 60_000);
    expect(await kids()).not.toContain(kidA);
    await expect(verify(tokenA)).rejects.toBeInstanceOf(
      errors.JWKSNoMatchingKey,
    );
  });
});
