import { describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "@better-auth/prisma-adapter";
import { createLocalJWKSet, decodeProtectedHeader, jwtVerify } from "jose";
import { prisma } from "@/lib/prisma";
import { buildJwtPlugin } from "@/lib/auth/jwt";
import {
  JwksRotationError,
  activateStagedKey,
  readKeys,
  stageKey,
} from "./jwks-rotation";

const ISSUER = "http://localhost:3000";
const SECRET = "s".repeat(32);
const DAY_MS = 24 * 60 * 60 * 1000;

// Only the jwt plugin: the rotation tool relies on its "newest live key signs"
// rule, so this file reruns against a real database on every Better Auth
// upgrade. The real plugin config comes from buildJwtPlugin.
const auth = betterAuth({
  database: prismaAdapter(prisma, { provider: "postgresql" }),
  advanced: { database: { generateId: false } },
  secret: SECRET,
  baseURL: ISSUER,
  plugins: [buildJwtPlugin({ prisma, issuer: ISSUER })],
});

async function sign(sub: string) {
  const { token } = await auth.api.signJWT({ body: { payload: { sub } } });
  return token;
}

const kidOf = (token: string) => decodeProtectedHeader(token).kid;

async function verify(token: string) {
  return jwtVerify(token, createLocalJWKSet(await auth.api.getJwks()), {
    issuer: ISSUER,
    audience: "authenticated",
  });
}

async function publishedKids() {
  const { keys } = await auth.api.getJwks();
  return keys.map((key) => key.kid);
}

describe("staged JWKS rotation", () => {
  it("stages, activates and retires a key", async () => {
    // 1. The first call mints the key that signs.
    const tokenA = await sign("user-a");
    const oldKid = kidOf(tokenA);
    expect(await publishedKids()).toEqual([oldKid]);

    // 2. A staged key is published but does not sign.
    const stagedKid = await stageKey(prisma, SECRET, new Date());
    expect(new Set(await publishedKids())).toEqual(
      new Set([oldKid, stagedKid]),
    );
    expect(kidOf(await sign("user-a"))).toBe(oldKid);

    // The staged private key decrypts like a plugin-made one: activation below
    // proves it by signing with it.
    const staged = await prisma.jwks.findUniqueOrThrow({
      where: { id: stagedKid },
    });
    expect(staged.alg).toBe("ES256");
    expect(staged.crv).toBe("P-256");
    expect(staged.privateKey).not.toContain("kty");

    // 3. Activation switches signing; both keys verify.
    const before = await prisma.auditEvent.count({
      where: { type: "JWKS_ROTATED" },
    });
    await activateStagedKey(prisma, new Date());
    const tokenB = await sign("user-b");
    expect(kidOf(tokenB)).toBe(stagedKid);
    await verify(tokenA);
    await verify(tokenB);
    expect(new Set(await publishedKids())).toEqual(
      new Set([oldKid, stagedKid]),
    );
    expect(
      await prisma.auditEvent.count({ where: { type: "JWKS_ROTATED" } }),
    ).toBe(before + 1);

    // 4. Seven days and a minute later the old key is no longer published.
    await prisma.jwks.update({
      where: { id: String(oldKid) },
      data: { expiresAt: new Date(Date.now() - 7 * DAY_MS - 60_000) },
    });
    expect(await publishedKids()).toEqual([stagedKid]);
  });

  it("refuses to activate with nothing staged", async () => {
    await expect(activateStagedKey(prisma, new Date())).rejects.toBeInstanceOf(
      JwksRotationError,
    );
  });

  it("refuses to stage twice", async () => {
    await sign("user-c");
    const keys = await readKeys(prisma, new Date());
    expect(keys.some((key) => key.state === "staged")).toBe(false);
    await stageKey(prisma, SECRET, new Date());
    await expect(stageKey(prisma, SECRET, new Date())).rejects.toBeInstanceOf(
      JwksRotationError,
    );
  });
});
