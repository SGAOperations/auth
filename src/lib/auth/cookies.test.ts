import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
import { describe, expect, it } from "vitest";
import {
  buildCookieOptions,
  resolveCookiePolicy,
  sessionCookieName,
} from "@/lib/auth/cookies";
import { resolveBaseURL, type SgauthEnv } from "@/lib/auth/settings";

const ENVS: SgauthEnv[] = ["production", "dev", "preview", "local"];
const SHARED_ENVS: SgauthEnv[] = ["production", "dev"];
const PREVIEW_GATE_COOKIE = "__Host-sgauth.preview-gate";

// Mirrors src/lib/auth/config.ts (it parses process.env and builds Prisma at
// import, so it cannot be imported here). Keep the two in step.
function optionsFor(env: SgauthEnv): BetterAuthOptions {
  return {
    baseURL: resolveBaseURL({
      sgauthEnv: env,
      vercelUrl: "sgauth-git-x.vercel.app",
    }),
    secret: "s".repeat(32),
    advanced: buildCookieOptions(resolveCookiePolicy(env)),
    session: { cookieCache: { enabled: false } },
  };
}

describe("resolveCookiePolicy", () => {
  it("returns the production row", () => {
    expect(resolveCookiePolicy("production")).toEqual({
      prefix: "sgauth",
      domain: "northeasternsga.com",
      secure: true,
    });
  });

  it("returns the dev row", () => {
    expect(resolveCookiePolicy("dev")).toEqual({
      prefix: "sgauth-dev",
      domain: "northeasternsga.com",
      secure: true,
    });
  });

  it("returns a host-only, secure preview row", () => {
    expect(resolveCookiePolicy("preview")).toEqual({
      prefix: "sgauth-preview",
      domain: null,
      secure: true,
    });
  });
});

describe("sessionCookieName", () => {
  it("prefixes every deployed environment with __Secure-", () => {
    expect(sessionCookieName(resolveCookiePolicy("production"))).toBe(
      "__Secure-sgauth.session_token",
    );
    expect(sessionCookieName(resolveCookiePolicy("dev"))).toBe(
      "__Secure-sgauth-dev.session_token",
    );
    expect(sessionCookieName(resolveCookiePolicy("preview"))).toBe(
      "__Secure-sgauth-preview.session_token",
    );
  });
});

describe("buildCookieOptions", () => {
  it("disables cross-subdomain cookies for preview", () => {
    const options = buildCookieOptions(resolveCookiePolicy("preview"));
    expect(options.crossSubDomainCookies?.enabled).toBe(false);
  });

  it.each(ENVS)("never puts a domain in the default attributes (%s)", (env) => {
    const { defaultCookieAttributes } = buildCookieOptions(
      resolveCookiePolicy(env),
    );
    expect(defaultCookieAttributes).not.toHaveProperty("domain");
  });
});

describe("Better Auth's view of the cookies", () => {
  it.each(SHARED_ENVS)("names and scopes the session cookie (%s)", (env) => {
    const { sessionToken } = getCookies(optionsFor(env));
    expect(sessionToken.name).toBe(sessionCookieName(resolveCookiePolicy(env)));
    expect(sessionToken.attributes).toMatchObject({
      domain: "northeasternsga.com",
      secure: true,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it("keeps the preview session cookie host-only", () => {
    const { sessionToken } = getCookies(optionsFor("preview"));
    expect(sessionToken.name).toBe("__Secure-sgauth-preview.session_token");
    expect(sessionToken.attributes).toMatchObject({ secure: true });
    expect(sessionToken.attributes).not.toHaveProperty("domain");
  });

  it("gives every environment disjoint cookie names", () => {
    const names = ENVS.flatMap((env) => {
      const cookies = getCookies(optionsFor(env));
      return [
        cookies.sessionToken.name,
        cookies.sessionData.name,
        cookies.dontRememberToken.name,
        cookies.accountData.name,
      ];
    });
    expect(new Set(names).size).toBe(names.length);
    expect(names).not.toContain(PREVIEW_GATE_COOKIE);
    expect(names.filter((name) => name.startsWith("__Host-"))).toEqual([]);
  });

  it("disables the session cookie cache", () => {
    expect(optionsFor("production").session?.cookieCache?.enabled).toBe(false);
  });
});

function testAuth(env: SgauthEnv) {
  return betterAuth({
    ...optionsFor(env),
    database: memoryAdapter({
      user: [],
      session: [],
      account: [],
      verification: [],
    }),
    emailAndPassword: { enabled: true },
  });
}

async function signUp(auth: ReturnType<typeof testAuth>) {
  const response = await auth.api.signUpEmail({
    body: {
      email: "cookie-test@example.com",
      password: "correct-horse-battery",
      name: "Cookie Test",
    },
    asResponse: true,
  });
  return parseSetCookieHeader(response.headers.get("set-cookie") ?? "");
}

async function signUpSetCookies(env: SgauthEnv) {
  return signUp(testAuth(env));
}

async function signOutSetCookies(env: SgauthEnv) {
  const auth = testAuth(env);
  const name = sessionCookieName(resolveCookiePolicy(env));
  const set = (await signUp(auth)).get(name);
  const response = await auth.api.signOut({
    headers: new Headers({ cookie: `${name}=${set?.value}` }),
    asResponse: true,
  });
  return {
    set,
    cleared: parseSetCookieHeader(response.headers.get("set-cookie") ?? ""),
  };
}

describe("Set-Cookie from a real sign-up", () => {
  it.each(SHARED_ENVS)("sets one parent-domain cookie (%s)", async (env) => {
    const cookies = await signUpSetCookies(env);
    const name = sessionCookieName(resolveCookiePolicy(env));
    expect([...cookies.keys()]).toEqual([name]);
    expect(cookies.get(name)).toMatchObject({
      domain: "northeasternsga.com",
      secure: true,
      httponly: true,
      samesite: "lax",
      path: "/",
    });
  });

  it("sets one host-only cookie for preview", async () => {
    const cookies = await signUpSetCookies("preview");
    const name = "__Secure-sgauth-preview.session_token";
    expect([...cookies.keys()]).toEqual([name]);
    expect(cookies.get(name)).toMatchObject({ secure: true, httponly: true });
    expect(cookies.get(name)).not.toHaveProperty("domain");
  });
});

describe("Set-Cookie from a real sign-out", () => {
  it.each(SHARED_ENVS)(
    "clears the session cookie it set, same scope (%s)",
    async (env) => {
      const { set, cleared } = await signOutSetCookies(env);
      const name = sessionCookieName(resolveCookiePolicy(env));
      const clearing = cleared.get(name);
      expect(set).toBeDefined();
      expect(clearing).toBeDefined();
      expect(clearing?.["max-age"]).toBe(0);
      expect(clearing?.domain).toBe("northeasternsga.com");
      expect(clearing?.domain).toBe(set?.domain);
      expect(clearing?.secure).toBe(true);
      expect(clearing?.secure).toBe(set?.secure);
      expect(clearing?.path).toBe("/");
      expect(clearing?.path).toBe(set?.path);
    },
  );

  it("clears the preview cookie host-only", async () => {
    const { set, cleared } = await signOutSetCookies("preview");
    const clearing = cleared.get("__Secure-sgauth-preview.session_token");
    expect(clearing?.["max-age"]).toBe(0);
    expect(clearing?.secure).toBe(true);
    expect(clearing).not.toHaveProperty("domain");
    expect(set).not.toHaveProperty("domain");
  });
});
