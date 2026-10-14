import { describe, expect, it } from "vitest";
import {
  UsageError,
  describeTarget,
  parseArgs,
  parseSyncEnv,
} from "./sync-env";

const SECRET = "hunter2-secret";

describe("parseArgs", () => {
  it("defaults to a dry run", () => {
    expect(parseArgs([])).toEqual({ apply: false });
  });

  it("accepts --apply", () => {
    expect(parseArgs(["--apply"])).toEqual({ apply: true });
  });

  it("refuses an unknown flag", () => {
    expect(() => parseArgs(["--nope"])).toThrow(UsageError);
    expect(() => parseArgs(["--apply", "--nope"])).toThrow(/--nope/);
  });
});

describe("parseSyncEnv", () => {
  const valid = {
    DIRECT_URL: "postgresql://user:pw@db.example.com:5432/auth",
    SGAUTH_ENV: "production",
  };

  it("accepts a valid environment", () => {
    expect(parseSyncEnv(valid)).toEqual(valid);
  });

  it("refuses a missing or invalid SGAUTH_ENV", () => {
    expect(() => parseSyncEnv({ ...valid, SGAUTH_ENV: undefined })).toThrow(
      UsageError,
    );
    expect(() => parseSyncEnv({ ...valid, SGAUTH_ENV: "staging" })).toThrow(
      /SGAUTH_ENV/,
    );
  });

  it("refuses a missing or empty DIRECT_URL", () => {
    expect(() => parseSyncEnv({ ...valid, DIRECT_URL: undefined })).toThrow(
      UsageError,
    );
    expect(() => parseSyncEnv({ ...valid, DIRECT_URL: "" })).toThrow(
      /DIRECT_URL/,
    );
  });

  it("refuses a malformed DIRECT_URL without echoing it", () => {
    const bad = `postgresql//user:${SECRET}@host/db`;
    let thrown: unknown;
    try {
      parseSyncEnv({ ...valid, DIRECT_URL: bad });
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toBeInstanceOf(UsageError);
    const error = thrown as UsageError;
    expect(error.message).toMatch(/DIRECT_URL/);
    expect(error.message).not.toContain(SECRET);
    expect(JSON.stringify(Object.entries(error))).not.toContain(SECRET);
    expect(error.cause).toBeUndefined();
  });
});

describe("describeTarget", () => {
  it("prints host and database, never credentials", () => {
    const target = describeTarget(
      `postgresql://user:${SECRET}@db.example.com:5432/auth?sslmode=require`,
    );
    expect(target).toBe("db.example.com:5432/auth");
    expect(target).not.toContain(SECRET);
  });
});
