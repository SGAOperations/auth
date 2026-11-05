import { describe, expect, it } from "vitest";
import { hashEndpoint } from "../../scripts/prisma-guard.mjs";
import { SeedRefusedError, assertSeedAllowed } from "./guard";

const MAIN_ID = "ep-fake-main-000000";
const DEV_ID = "ep-fake-dev-111111";
const OTHER_ID = "ep-personal-222222";
const options = {
  protectedEndpoints: [
    { branch: "main", sha256: hashEndpoint(MAIN_ID) },
    { branch: "dev", sha256: hashEndpoint(DEV_ID) },
  ],
};

const pooled = (id: string) =>
  `postgresql://runtime:s3cret@${id}-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full`;
const direct = (id: string) =>
  `postgresql://migration:s3cret@${id}.us-east-1.aws.neon.tech/neondb?sslmode=verify-full`;

describe("assertSeedAllowed", () => {
  it("refuses production and points at positions:sync", () => {
    const target = {
      sgauthEnv: "production" as const,
      databaseUrl: pooled(OTHER_ID),
    };
    expect(() => assertSeedAllowed(target, options)).toThrow(SeedRefusedError);
    expect(() => assertSeedAllowed(target, options)).toThrow(
      /npm run positions:sync/,
    );
  });

  it.each(["dev", "preview", "local"] as const)(
    "allows %s on a personal branch",
    (sgauthEnv) => {
      expect(() =>
        assertSeedAllowed(
          {
            sgauthEnv,
            databaseUrl: pooled(OTHER_ID),
            directUrl: direct(OTHER_ID),
          },
          options,
        ),
      ).not.toThrow();
    },
  );

  it.each(["dev", "preview", "local"] as const)(
    "refuses the main endpoint with SGAUTH_ENV=%s, through either URL",
    (sgauthEnv) => {
      for (const target of [
        { sgauthEnv, databaseUrl: pooled(MAIN_ID) },
        {
          sgauthEnv,
          databaseUrl: pooled(OTHER_ID),
          directUrl: direct(MAIN_ID),
        },
      ]) {
        expect(() => assertSeedAllowed(target, options)).toThrow(
          /DATABASE_URL|DIRECT_URL/,
        );
        expect(() => assertSeedAllowed(target, options)).toThrow(
          /points at the Neon main branch/,
        );
      }
    },
  );

  it("seeds the shared dev endpoint only with SGAUTH_ENV=dev", () => {
    const urls = { databaseUrl: pooled(DEV_ID), directUrl: direct(DEV_ID) };
    expect(() =>
      assertSeedAllowed({ sgauthEnv: "dev", ...urls }, options),
    ).not.toThrow();
    for (const sgauthEnv of ["local", "preview"] as const) {
      expect(() => assertSeedAllowed({ sgauthEnv, ...urls }, options)).toThrow(
        /points at the Neon dev branch and SGAUTH_ENV is not dev/,
      );
    }
  });

  it("refuses a host listed in SGAUTH_PROTECTED_DB_HOSTS", () => {
    for (const protectedHosts of [
      `${OTHER_ID}.us-east-1.aws.neon.tech`,
      ` ep-unrelated-333333 , ,${OTHER_ID} `,
    ]) {
      expect(() =>
        assertSeedAllowed(
          { sgauthEnv: "local", databaseUrl: pooled(OTHER_ID), protectedHosts },
          options,
        ),
      ).toThrow(/listed in SGAUTH_PROTECTED_DB_HOSTS/);
    }
  });

  it("fails closed on a missing or invalid URL", () => {
    expect(() =>
      assertSeedAllowed(
        { sgauthEnv: "local", databaseUrl: undefined },
        options,
      ),
    ).toThrow(/DATABASE_URL is not set/);
    expect(() =>
      assertSeedAllowed(
        { sgauthEnv: "local", databaseUrl: "not a url s3cret" },
        options,
      ),
    ).toThrow(/DATABASE_URL is not a valid URL/);
    expect(() =>
      assertSeedAllowed(
        {
          sgauthEnv: "local",
          databaseUrl: pooled(OTHER_ID),
          directUrl: "not a url s3cret",
        },
        options,
      ),
    ).toThrow(/DIRECT_URL is not a valid URL/);
  });

  it("never echoes a connection string", () => {
    for (const target of [
      { sgauthEnv: "local" as const, databaseUrl: pooled(MAIN_ID) },
      { sgauthEnv: "local" as const, databaseUrl: "not a url s3cret" },
    ]) {
      let message = "";
      try {
        assertSeedAllowed(target, options);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).not.toBe("");
      for (const secret of ["s3cret", "runtime:", MAIN_ID]) {
        expect(message).not.toContain(secret);
      }
    }
  });

  it("uses the shipped hashed list by default", () => {
    expect(() =>
      assertSeedAllowed({
        sgauthEnv: "local",
        databaseUrl: pooled("ep-example-123456"),
      }),
    ).not.toThrow();
  });
});
