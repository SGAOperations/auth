import { describe, expect, it } from "vitest";
import { SignJWT, generateKeyPair } from "jose";
import {
  buildOpenIdConfiguration,
  toTokenPayload,
  type TokenClaims,
} from "@/lib/auth/jwt";
import { JWT_ALG, JWT_AUDIENCE } from "@/lib/auth/jwt-constants";

const USER_ID = "0194f3c2-7b1e-7c3a-9d4e-5a6b7c8d9e0f";
const ISSUER = "https://auth.northeasternsga.com";

const claims = (overrides: Partial<TokenClaims> = {}): TokenClaims => ({
  email: "student.officer@northeastern.edu",
  name: "Student Officer",
  status: "ACTIVE",
  isAdmin: false,
  isPrimaryAdmin: false,
  positionKeys: [],
  ...overrides,
});

describe("toTokenPayload", () => {
  it("builds the claims, with positions sorted", () => {
    expect(
      toTokenPayload(
        claims({
          isAdmin: true,
          positionKeys: ["treasurer", "president", "senator"],
        }),
      ),
    ).toEqual({
      email: "student.officer@northeastern.edu",
      name: "Student Officer",
      role: "authenticated",
      positions: ["president", "senator", "treasurer"],
      is_admin: true,
      is_primary_admin: false,
    });
  });

  it("does not reorder the caller's array", () => {
    const positionKeys = ["b", "a"];
    toTokenPayload(claims({ positionKeys }));
    expect(positionKeys).toEqual(["b", "a"]);
  });

  it("refuses a deactivated user with ACCOUNT_DEACTIVATED", () => {
    expect(() => toTokenPayload(claims({ status: "DEACTIVATED" }))).toThrow(
      expect.objectContaining({
        status: "UNAUTHORIZED",
        body: expect.objectContaining({ code: "ACCOUNT_DEACTIVATED" }),
      }),
    );
  });

  it("refuses a missing user", () => {
    expect(() => toTokenPayload(null)).toThrow(
      expect.objectContaining({ status: "UNAUTHORIZED" }),
    );
  });
});

describe("buildOpenIdConfiguration", () => {
  it("is the minimal discovery document", () => {
    expect(buildOpenIdConfiguration(ISSUER)).toEqual({
      issuer: ISSUER,
      jwks_uri: `${ISSUER}/api/auth/jwks`,
      id_token_signing_alg_values_supported: ["ES256"],
      subject_types_supported: ["public"],
    });
  });
});

describe("token size", () => {
  async function tokenFor(positionKeys: string[]) {
    const { privateKey } = await generateKeyPair(JWT_ALG);
    return new SignJWT(toTokenPayload(claims({ positionKeys })))
      .setProtectedHeader({
        alg: JWT_ALG,
        kid: "0194f3c2-7b1e-7c3a-9d4e-5a6b7c8d9e10",
      })
      .setIssuer(ISSUER)
      .setAudience(JWT_AUDIENCE)
      .setSubject(USER_ID)
      .setIssuedAt()
      .setExpirationTime("10m")
      .sign(privateKey);
  }

  const key = (n: number, length: number) =>
    `p${n}-`.padEnd(length, "x").slice(0, length);

  it("stays under 8 KB in the worst case: 50 positions of 64 characters", async () => {
    const token = await tokenFor(
      Array.from({ length: 50 }, (_, n) => key(n, 64)),
    );
    expect(token.length).toBeLessThan(8192);
  });

  it("stays under 2 KB for a typical user: 5 positions of 20 characters", async () => {
    const token = await tokenFor(
      Array.from({ length: 5 }, (_, n) => key(n, 20)),
    );
    expect(token.length).toBeLessThan(2048);
  });
});
