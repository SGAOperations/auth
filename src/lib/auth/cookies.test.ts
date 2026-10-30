import { betterAuth, type BetterAuthOptions } from "better-auth";
import { memoryAdapter } from "better-auth/adapters/memory";
import { getCookies, parseSetCookieHeader } from "better-auth/cookies";
import { describe, expect, it } from "vitest";
import {
  DEVICE_COOKIE_MAX_AGE_SECONDS,
  TWO_FACTOR_COOKIE,
  assertSecureCookieConfig,
  buildCookieOptions,
  deviceCookieName,
  resolveCookiePolicy,
  sessionCookieName,
  twoFactorCookieName,
} from "@/lib/auth/cookies";
import {
  SESSION_EXPIRES_IN_SECONDS,
  SESSION_OPTIONS,
} from "@/lib/auth/session-lifetime";
import { resolveBaseURL, type SgauthEnv } from "@/lib/auth/settings";

const ENVS: SgauthEnv[] = ["production", "dev", "preview", "local"];
const SHARED_ENVS: SgauthEnv[] = ["production", "dev"];
const PREVIEW_GATE_COOKIE = "__Host-sgauth.preview-gate";

// Mirrors src/lib/auth/config.ts (it parses process.env and builds Prisma at
// import, so it cannot be imported here). The session options come from
// session-lifetime.ts, which both share, so only the cookie options are
// mirrored. Keep those in step.
function optionsFor(env: SgauthEnv): BetterAuthOptions {
  return {
    baseURL: resolveBaseURL({
      sgauthEnv: env,
      vercelUrl: "sgauth-git-x.vercel.app",
    }),
    secret: "s".repeat(32),
    advanced: buildCookieOptions(resolveCookiePolicy(env)),
    session: SESSION_OPTIONS,
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

describe("resolveCookiePolicy local", () => {
  it("returns a parent-domain, non-secure local row", () => {
    expect(resolveCookiePolicy("local")).toEqual({
      prefix: "sgauth-local",
      domain: "sga.localhost",
      secure: false,
    });
  });
});

describe("sessionCookieName", () => {
  it("names the local cookie without __Secure-", () => {
    expect(sessionCookieName(resolveCookiePolicy("local"))).toBe(
      "sgauth-local.session_token",
    );
  });

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

describe("deviceCookieName", () => {
  it("names the production cookie exactly", () => {
    expect(deviceCookieName(resolveCookiePolicy("production"))).toBe(
      "__Secure-sgauth.device",
    );
  });

  it("follows each environment's prefix and Secure rule", () => {
    expect(deviceCookieName(resolveCookiePolicy("dev"))).toBe(
      "__Secure-sgauth-dev.device",
    );
    expect(deviceCookieName(resolveCookiePolicy("preview"))).toBe(
      "__Secure-sgauth-preview.device",
    );
    expect(deviceCookieName(resolveCookiePolicy("local"))).toBe(
      "sgauth-local.device",
    );
  });

  it("lasts one year", () => {
    expect(DEVICE_COOKIE_MAX_AGE_SECONDS).toBe(31_536_000);
  });
});

describe("twoFactorCookieName", () => {
  it("names the challenge cookie for every environment", () => {
    expect(twoFactorCookieName(resolveCookiePolicy("production"))).toBe(
      "__Secure-sgauth.two_factor",
    );
    expect(twoFactorCookieName(resolveCookiePolicy("local"))).toBe(
      "sgauth-local.two_factor",
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

  it("scopes the local session cookie to sga.localhost without Secure", () => {
    const { sessionToken } = getCookies(optionsFor("local"));
    expect(sessionToken.name).toBe("sgauth-local.session_token");
    expect(sessionToken.attributes).toMatchObject({
      domain: "sga.localhost",
      secure: false,
      httpOnly: true,
      sameSite: "lax",
      path: "/",
    });
  });

  it.each(ENVS)(
    "names the two_factor cookie as Better Auth does (%s)",
    async (env) => {
      const context = await testAuth(env).$context;
      expect(twoFactorCookieName(resolveCookiePolicy(env))).toBe(
        context.createAuthCookie(TWO_FACTOR_COOKIE).name,
      );
    },
  );

  it("gives every environment disjoint cookie names", () => {
    const names = ENVS.flatMap((env) => {
      const cookies = getCookies(optionsFor(env));
      return [
        cookies.sessionToken.name,
        cookies.sessionData.name,
        cookies.dontRememberToken.name,
        cookies.accountData.name,
        twoFactorCookieName(resolveCookiePolicy(env)),
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

type Advanced = NonNullable<BetterAuthOptions["advanced"]>;

function checkInput(
  sgauthEnv: SgauthEnv,
  overrides: { advanced?: Partial<Advanced>; baseURL?: string } = {},
  vercelEnv?: string,
) {
  const base = optionsFor(sgauthEnv);
  return {
    sgauthEnv,
    baseURL: overrides.baseURL ?? (base.baseURL as string),
    vercelEnv,
    advanced: { ...base.advanced, ...overrides.advanced },
  };
}

describe("assertSecureCookieConfig", () => {
  it.each(ENVS)("passes the real configuration (%s)", (env) => {
    expect(() => assertSecureCookieConfig(checkInput(env))).not.toThrow();
  });

  it("refuses production with useSecureCookies off", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("production", { advanced: { useSecureCookies: false } }),
      ),
    ).toThrow(
      "Insecure cookie configuration for SGAUTH_ENV=production:\n- useSecureCookies must be true",
    );
  });

  it("refuses production with a non-secure default attribute", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("production", {
          advanced: {
            defaultCookieAttributes: {
              httpOnly: true,
              secure: false,
              sameSite: "lax",
              path: "/",
            },
          },
        }),
      ),
    ).toThrow(/defaultCookieAttributes\.secure must not be false/);
  });

  it("refuses production with a non-HttpOnly default attribute", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("production", {
          advanced: {
            defaultCookieAttributes: {
              httpOnly: false,
              secure: true,
              sameSite: "lax",
              path: "/",
            },
          },
        }),
      ),
    ).toThrow(/defaultCookieAttributes\.httpOnly must not be false/);
  });

  it("refuses production with an http baseURL", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("production", {
          baseURL: "http://auth.northeasternsga.com",
        }),
      ),
    ).toThrow(/baseURL must use https/);
  });

  it("refuses production on the local cookie domain", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("production", {
          advanced: {
            crossSubDomainCookies: { enabled: true, domain: "sga.localhost" },
          },
        }),
      ),
    ).toThrow(/crossSubDomainCookies must be enabled on northeasternsga\.com/);
  });

  it("refuses production with cross-subdomain cookies disabled", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("production", {
          advanced: { crossSubDomainCookies: { enabled: false } },
        }),
      ),
    ).toThrow(/crossSubDomainCookies must be enabled/);
  });

  it("refuses dev with the production prefix", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("dev", { advanced: { cookiePrefix: "sgauth" } }),
      ),
    ).toThrow(/cookiePrefix must be "sgauth-dev"/);
  });

  it("refuses SameSite=None", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("dev", {
          advanced: {
            defaultCookieAttributes: {
              httpOnly: true,
              secure: true,
              sameSite: "none",
              path: "/",
            },
          },
        }),
      ),
    ).toThrow(/sameSite must be "lax"/);
  });

  it.each(["production", "preview"])(
    "refuses local when VERCEL_ENV is %s",
    (vercelEnv) => {
      expect(() =>
        assertSecureCookieConfig(checkInput("local", {}, vercelEnv)),
      ).toThrow(
        "Insecure cookie configuration for SGAUTH_ENV=local:\n- SGAUTH_ENV=local cannot run on Vercel",
      );
    },
  );

  it("allows local with VERCEL_ENV unset", () => {
    expect(() => assertSecureCookieConfig(checkInput("local"))).not.toThrow();
  });

  it("refuses local on a real host", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("local", { baseURL: "http://auth.northeasternsga.com" }),
      ),
    ).toThrow(/baseURL host must end in \.localhost/);
  });

  it("refuses local on an unparseable baseURL", () => {
    expect(() =>
      assertSecureCookieConfig(checkInput("local", { baseURL: "not a url" })),
    ).toThrow(/baseURL host must end in \.localhost/);
  });

  it("refuses local with useSecureCookies on", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("local", { advanced: { useSecureCookies: true } }),
      ),
    ).toThrow(/useSecureCookies must be false/);
  });

  it("refuses local on the parent cookie domain", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("local", {
          advanced: {
            crossSubDomainCookies: {
              enabled: true,
              domain: "northeasternsga.com",
            },
          },
        }),
      ),
    ).toThrow(/crossSubDomainCookies must be enabled on sga\.localhost/);
  });

  it("refuses local with cross-subdomain cookies disabled", () => {
    expect(() =>
      assertSecureCookieConfig(
        checkInput("local", {
          advanced: { crossSubDomainCookies: { enabled: false } },
        }),
      ),
    ).toThrow(/crossSubDomainCookies must be enabled on sga\.localhost/);
  });

  it("reports every failure on its own line", () => {
    let message = "";
    try {
      assertSecureCookieConfig(
        checkInput("production", {
          advanced: {
            useSecureCookies: false,
            crossSubDomainCookies: { enabled: false },
          },
        }),
      );
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message.split("\n")).toHaveLength(3);
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
    expect(cookies.get(name)?.["max-age"]).toBe(SESSION_EXPIRES_IN_SECONDS);
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
