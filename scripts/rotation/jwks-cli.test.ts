import { describe, expect, it } from "vitest";
import { UsageError } from "../../prisma/seed/sync-env";
import { buildSecretConfig, parseRotateArgs, parseRotateEnv } from "./jwks-cli";

const SECRET = "a".repeat(32);
const NEW = "n".repeat(32);
const ISSUER = "https://auth-dev.northeasternsga.com";

describe("parseRotateArgs", () => {
  it("defaults to a dry-run status", () => {
    expect(parseRotateArgs([])).toEqual({
      command: "status",
      apply: false,
      issuer: undefined,
      kid: undefined,
    });
  });

  it("parses stage with --apply", () => {
    expect(parseRotateArgs(["stage", "--apply"]).apply).toBe(true);
  });

  it("requires --issuer for activate", () => {
    expect(() => parseRotateArgs(["activate"])).toThrow(/needs --issuer/);
    expect(parseRotateArgs(["activate", "--issuer", ISSUER]).issuer).toBe(
      ISSUER,
    );
  });

  it("requires --kid for retire", () => {
    expect(() => parseRotateArgs(["retire"])).toThrow(/needs --kid/);
    expect(parseRotateArgs(["retire", "--kid", "k1", "--apply"]).kid).toBe(
      "k1",
    );
  });

  it("keeps --issuer and --kid to their own commands", () => {
    expect(() => parseRotateArgs(["stage", "--issuer", ISSUER])).toThrow(
      /activate only/,
    );
    expect(() => parseRotateArgs(["stage", "--kid", "k1"])).toThrow(
      /retire only/,
    );
  });

  it.each([
    ["an unknown command", ["bogus"]],
    ["a second command", ["status", "stage"]],
    ["an unknown flag", ["status", "--force"]],
    ["a flag with no value", ["activate", "--issuer"]],
    ["a flag followed by a flag", ["retire", "--kid", "--apply"]],
    ["an http issuer", ["activate", "--issuer", "http://x.example"]],
    ["an issuer with a trailing slash", ["activate", "--issuer", `${ISSUER}/`]],
  ])("rejects %s with a UsageError", (_, argv) => {
    expect(() => parseRotateArgs(argv)).toThrow(UsageError);
  });
});

describe("buildSecretConfig", () => {
  it("is the plain secret without versions", () => {
    expect(buildSecretConfig(SECRET, undefined)).toBe(SECRET);
  });

  it("mirrors Better Auth's config with versions", () => {
    expect(
      buildSecretConfig(SECRET, [
        { version: 2, value: NEW },
        { version: 1, value: "o".repeat(32) },
      ]),
    ).toEqual({
      keys: new Map([
        [2, NEW],
        [1, "o".repeat(32)],
      ]),
      currentVersion: 2,
      legacySecret: SECRET,
    });
  });
});

describe("parseRotateEnv", () => {
  const base = {
    DIRECT_URL: "postgresql://migration:pw@ep-x.neon.tech/neondb",
    SGAUTH_ENV: "dev",
    BETTER_AUTH_SECRET: SECRET,
  };

  it("returns the plain secret when no versions are set", () => {
    const env = parseRotateEnv(base);
    expect(env.secret).toBe(SECRET);
    expect(env.sgauthEnv).toBe("dev");
  });

  it("treats an empty BETTER_AUTH_SECRETS as unset", () => {
    expect(parseRotateEnv({ ...base, BETTER_AUTH_SECRETS: "" }).secret).toBe(
      SECRET,
    );
  });

  it("builds the versioned config when set", () => {
    const env = parseRotateEnv({ ...base, BETTER_AUTH_SECRETS: `1:${NEW}` });
    expect(env.secret).toEqual({
      keys: new Map([[1, NEW]]),
      currentVersion: 1,
      legacySecret: SECRET,
    });
  });

  it("names the broken variables without echoing values", () => {
    let message = "";
    try {
      parseRotateEnv({
        ...base,
        DIRECT_URL: "not a url, pw",
        BETTER_AUTH_SECRET: "short",
      });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("DIRECT_URL");
    expect(message).toContain("BETTER_AUTH_SECRET");
    expect(message).not.toContain("short");
    expect(message).not.toContain("pw");
  });

  it("names the bad secrets entry by position, never its value", () => {
    const bad = "z".repeat(31);
    let message = "";
    try {
      parseRotateEnv({ ...base, BETTER_AUTH_SECRETS: `1:${NEW},2:${bad}` });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("BETTER_AUTH_SECRETS: entry #2");
    expect(message).not.toContain(bad);
  });
});
