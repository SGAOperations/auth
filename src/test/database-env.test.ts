import { describe, expect, it } from "vitest";
import { resolveTestDatabase } from "./database-env";

const POOLED =
  "postgresql://runtime:secret-one@ep-test-123456-pooler.us-east-1.aws.neon.tech/neondb?sslmode=verify-full";
const DIRECT =
  "postgresql://migration:secret-two@ep-test-123456.us-east-1.aws.neon.tech/neondb?sslmode=verify-full";
const APP_POOLED =
  "postgresql://runtime:secret-three@ep-dev-654321-pooler.us-east-1.aws.neon.tech/neondb";
const APP_DIRECT =
  "postgresql://migration:secret-four@ep-dev-654321.us-east-1.aws.neon.tech/neondb";

const SECRETS = ["secret-one", "secret-two", "secret-three", "secret-four"];

function messageOf(fn: () => unknown): string {
  try {
    fn();
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error("expected a throw");
}

function expectNoSecrets(message: string) {
  for (const secret of SECRETS) expect(message).not.toContain(secret);
  expect(message).not.toContain("neon.tech");
}

describe("resolveTestDatabase", () => {
  it("accepts a Neon pooled/direct pair", () => {
    expect(
      resolveTestDatabase({
        TEST_DATABASE_URL: POOLED,
        TEST_DIRECT_URL: DIRECT,
        DATABASE_URL: APP_POOLED,
        DIRECT_URL: APP_DIRECT,
      }),
    ).toEqual({ databaseUrl: POOLED, directUrl: DIRECT });
  });

  it("accepts a localhost pair and unset app URLs", () => {
    const local = "postgresql://postgres:secret-one@localhost:5432/postgres";
    expect(
      resolveTestDatabase({
        TEST_DATABASE_URL: local,
        TEST_DIRECT_URL: local,
      }),
    ).toEqual({ databaseUrl: local, directUrl: local });
  });

  it("throws when TEST_DATABASE_URL is missing", () => {
    const message = messageOf(() =>
      resolveTestDatabase({ TEST_DIRECT_URL: DIRECT }),
    );
    expect(message).toContain("must point at a personal Neon branch");
    expectNoSecrets(message);
  });

  it("throws when TEST_DIRECT_URL is missing", () => {
    const message = messageOf(() =>
      resolveTestDatabase({ TEST_DATABASE_URL: POOLED }),
    );
    expect(message).toContain("must point at a personal Neon branch");
    expectNoSecrets(message);
  });

  it("refuses a TEST_DATABASE_URL equal to DATABASE_URL", () => {
    const message = messageOf(() =>
      resolveTestDatabase({
        TEST_DATABASE_URL: POOLED,
        TEST_DIRECT_URL: DIRECT,
        DATABASE_URL: POOLED,
      }),
    );
    expect(message).toContain("must not equal");
    expectNoSecrets(message);
  });

  it("refuses a TEST_DIRECT_URL equal to DIRECT_URL", () => {
    const message = messageOf(() =>
      resolveTestDatabase({
        TEST_DATABASE_URL: POOLED,
        TEST_DIRECT_URL: DIRECT,
        DIRECT_URL: DIRECT,
      }),
    );
    expect(message).toContain("must not equal");
    expectNoSecrets(message);
  });

  it("refuses a pair that points at different endpoints", () => {
    const message = messageOf(() =>
      resolveTestDatabase({
        TEST_DATABASE_URL: POOLED,
        TEST_DIRECT_URL: APP_DIRECT,
      }),
    );
    expect(message).toContain("point at different endpoints");
    expectNoSecrets(message);
  });

  it("refuses a value that is not a URL without echoing it", () => {
    const message = messageOf(() =>
      resolveTestDatabase({
        TEST_DATABASE_URL: "secret-one-not-a-url",
        TEST_DIRECT_URL: DIRECT,
      }),
    );
    expect(message).toContain("valid URLs");
    expectNoSecrets(message);
  });
});
