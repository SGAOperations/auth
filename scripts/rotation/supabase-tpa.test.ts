import { describe, expect, it } from "vitest";
import { UsageError } from "../../prisma/seed/sync-env";
import {
  DEFAULT_ISSUER,
  integrationSchema,
  kidsOf,
  matchIntegrations,
  parseIssuer,
  parsePublicJwks,
  parsePushArgs,
  parsePushEnv,
  planProject,
  resolvedCovers,
} from "./supabase-tpa";

const ISSUER = "https://auth.northeasternsga.com";
const REF = "abcdefghijklmnopqrst";

const jwk = (kid: string, extra: Record<string, unknown> = {}) => ({
  kty: "EC",
  crv: "P-256",
  alg: "ES256",
  kid,
  x: "xx",
  y: "yy",
  ...extra,
});

const integration = (fields: Record<string, unknown>) =>
  integrationSchema.parse({ id: "id", ...fields });

describe("parseIssuer", () => {
  it("accepts an https origin", () => {
    expect(parseIssuer(ISSUER)).toBe(ISSUER);
  });

  it.each([
    "https://auth.northeasternsga.com/",
    "https://auth.northeasternsga.com/api",
    "https://auth.northeasternsga.com?x=1",
    "http://auth.northeasternsga.com",
    "not a url",
  ])("rejects %s", (value) => {
    expect(() => parseIssuer(value)).toThrow(UsageError);
  });
});

describe("parsePushArgs", () => {
  it("defaults the issuer and collects project refs", () => {
    const args = parsePushArgs([
      "--project-ref",
      REF,
      "--project-ref",
      "tsrqponmlkjihgfedcba",
      "--project-ref",
      REF,
    ]);
    expect(args.issuer).toBe(DEFAULT_ISSUER);
    expect(args.projectRefs).toEqual([REF, "tsrqponmlkjihgfedcba"]);
    expect(args.apply).toBe(false);
  });

  it("parses --issuer and --apply", () => {
    const args = parsePushArgs([
      "--issuer",
      "https://auth-dev.northeasternsga.com",
      "--project-ref",
      REF,
      "--apply",
    ]);
    expect(args.issuer).toBe("https://auth-dev.northeasternsga.com");
    expect(args.apply).toBe(true);
  });

  it("allows --help without a project", () => {
    expect(parsePushArgs(["--help"]).help).toBe(true);
  });

  it.each([
    ["no project", []],
    ["a short ref", ["--project-ref", "abc"]],
    ["an uppercase ref", ["--project-ref", "ABCDEFGHIJKLMNOPQRST"]],
    [
      "a trailing-slash issuer",
      ["--issuer", `${ISSUER}/`, "--project-ref", REF],
    ],
    ["an unknown flag", ["--project-ref", REF, "--force"]],
    ["a flag with no value", ["--project-ref"]],
  ])("rejects %s", (_, argv) => {
    expect(() => parsePushArgs(argv)).toThrow(UsageError);
  });
});

describe("parsePushEnv", () => {
  it("returns the token", () => {
    expect(parsePushEnv({ SUPABASE_ACCESS_TOKEN: "sbp_x" })).toEqual({
      accessToken: "sbp_x",
    });
  });

  it("names the variable only", () => {
    expect(() => parsePushEnv({})).toThrow("SUPABASE_ACCESS_TOKEN");
    expect(() => parsePushEnv({ SUPABASE_ACCESS_TOKEN: "" })).toThrow(
      UsageError,
    );
  });
});

describe("parsePublicJwks", () => {
  it("strips extra members", () => {
    const { keys } = parsePublicJwks({
      keys: [jwk("k1", { use: "sig", extra: "drop" })],
    });
    expect(keys).toEqual([{ ...jwk("k1"), use: "sig" }]);
  });

  it("refuses a key carrying private material", () => {
    expect(() =>
      parsePublicJwks({ keys: [jwk("k1", { d: "PRIVATE" })] }),
    ).toThrow(/invalid/);
  });

  it("does not echo the private member in the error", () => {
    let message = "";
    try {
      parsePublicJwks({ keys: [jwk("k1", { d: "PRIVATE-MATERIAL" })] });
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).not.toContain("PRIVATE-MATERIAL");
  });

  it.each([
    ["an empty set", { keys: [] }],
    ["a wrong algorithm", { keys: [jwk("k1", { alg: "RS256" })] }],
    ["a wrong curve", { keys: [jwk("k1", { crv: "P-384" })] }],
    ["a missing kid", { keys: [{ ...jwk("k1"), kid: undefined }] }],
    ["not an object", "keys"],
  ])("refuses %s", (_, json) => {
    expect(() => parsePublicJwks(json)).toThrow(/invalid/);
  });
});

describe("kidsOf", () => {
  it("lists key ids, and yields none for anything else", () => {
    expect(kidsOf({ keys: [jwk("a"), jwk("b")] })).toEqual(["a", "b"]);
    expect(kidsOf(null)).toEqual([]);
    expect(kidsOf({ keys: "x" })).toEqual([]);
  });
});

describe("matchIntegrations", () => {
  const live = ["new", "old"];

  it("sorts issuer-bound, inline and foreign integrations", () => {
    const oidc = integration({ id: "oidc", oidc_issuer_url: ISSUER });
    const url = integration({
      id: "url",
      jwks_url: `${ISSUER}/.well-known/jwks.json`,
    });
    const inline = integration({
      id: "inline",
      custom_jwks: { keys: [jwk("old")] },
    });
    const foreignInline = integration({
      id: "foreign-inline",
      custom_jwks: { keys: [jwk("someone-else")] },
    });
    const foreignIssuer = integration({
      id: "foreign-issuer",
      oidc_issuer_url: "https://other.example.com",
    });

    const match = matchIntegrations(
      [oidc, url, inline, foreignInline, foreignIssuer],
      ISSUER,
      live,
    );
    expect(match.issuerBound.map((item) => item.id)).toEqual(["oidc", "url"]);
    expect(match.inlineSgauth.map((item) => item.id)).toEqual(["inline"]);
  });

  it("does not match an issuer that differs by a path", () => {
    const other = integration({ oidc_issuer_url: `${ISSUER}/x` });
    const match = matchIntegrations([other], ISSUER, live);
    expect(match.issuerBound).toEqual([]);
  });
});

describe("planProject", () => {
  it("errors when nothing is registered", () => {
    expect(planProject({ issuerBound: [], inlineSgauth: [] })).toEqual({
      kind: "error",
      reason: "not registered (run scripts/supabase-register-tpa.ts, #93)",
    });
  });

  it("only verifies an issuer-bound project", () => {
    const bound = integration({ id: "bound", oidc_issuer_url: ISSUER });
    const plan = planProject({ issuerBound: [bound], inlineSgauth: [] });
    expect(plan).toEqual({
      kind: "ok",
      push: false,
      deleteAfterCreate: [],
      verify: [bound],
    });
  });

  it("pushes and replaces an inline integration", () => {
    const inline = integration({ id: "inline" });
    const plan = planProject({ issuerBound: [], inlineSgauth: [inline] });
    expect(plan).toMatchObject({
      kind: "ok",
      push: true,
      deleteAfterCreate: ["inline"],
    });
  });
});

describe("resolvedCovers", () => {
  it("is true only when every live kid is resolved", () => {
    const resolved = { keys: [jwk("a"), jwk("b")] };
    expect(resolvedCovers(resolved, ["a", "b"])).toBe(true);
    expect(resolvedCovers(resolved, ["a", "c"])).toBe(false);
  });

  it("is false for nothing resolved or nothing live", () => {
    expect(resolvedCovers(null, ["a"])).toBe(false);
    expect(resolvedCovers({ keys: [jwk("a")] }, [])).toBe(false);
  });
});
