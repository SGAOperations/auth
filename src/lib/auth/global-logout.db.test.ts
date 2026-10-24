import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildCookieOptions, resolveCookiePolicy } from "@/lib/auth/cookies";
import { createLogoutHandler, createRevokeAllHandler } from "@/lib/auth/logout";
import { buildAuthOptions } from "@/lib/auth/options";
import { revokeAllSessionsForUser } from "@/lib/auth/revocation";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "https://auth.northeasternsga.com";
const PRODUCT = "https://vaultz.northeasternsga.com";
const STRONG = "correct-horse-battery-staple";

describe.skipIf(!url)("global logout and revocation", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth({
    ...buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      trustedOrigins: [BASE_URL, PRODUCT],
      advanced: buildCookieOptions(resolveCookiePolicy("production")),
    }),
    session: { cookieCache: { enabled: false } },
  });
  const revokeAll = createRevokeAllHandler({ auth });
  const logout = createLogoutHandler({
    auth,
    sgauthOrigin: BASE_URL,
    allowHttpProducts: false,
    isAllowedRedirect: (href) => new URL(href).origin === PRODUCT,
    log: { warn: () => {}, error: () => {} },
  });

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  // Audit rows cannot be deleted; every assertion filters by this run's users.
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function verifiedUser() {
    const email = `t42-${counter++}-${rand}@northeastern.edu`;
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    return prisma.user.findUniqueOrThrow({ where: { email } });
  }

  async function signIn(email: string) {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email, password: STRONG }),
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
  }

  async function userWithSessions(count: number) {
    const user = await verifiedUser();
    const cookies: string[] = [];
    for (let i = 0; i < count; i++) cookies.push(await signIn(user.email));
    return { user, cookies };
  }

  const sessionCount = (userId: string) =>
    prisma.session.count({ where: { userId } });

  const events = (userId: string, type: string) =>
    prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
    });

  function expiresParentCookie(setCookies: string[]) {
    const entry = setCookies.find((cookie) =>
      cookie.startsWith("__Secure-sgauth.session_token="),
    );
    expect(entry).toBeDefined();
    expect(entry).toMatch(/Domain=northeasternsga\.com/i);
    expect(entry).toMatch(/Path=\//i);
    expect(entry).toMatch(/Max-Age=0/i);
  }

  const post = (path: string, headers: Record<string, string>) =>
    new Request(`${BASE_URL}${path}`, {
      method: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: "{}",
    });

  it("signs out: row deleted, parent-domain cookie expired, one LOGOUT", async () => {
    const {
      user,
      cookies: [cookie],
    } = await userWithSessions(1);

    const response = await auth.handler(
      post("/api/auth/sign-out", { cookie, origin: PRODUCT }),
    );

    expect(response.status).toBe(200);
    expect(await sessionCount(user.id)).toBe(0);
    expiresParentCookie(response.headers.getSetCookie());
    expect(await events(user.id, "LOGOUT")).toHaveLength(1);
  });

  it("resolves no session from another subdomain after sign-out", async () => {
    const {
      user,
      cookies: [cookie],
    } = await userWithSessions(1);
    await auth.handler(post("/api/auth/sign-out", { cookie, origin: PRODUCT }));

    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        headers: { cookie, origin: "https://other.northeasternsga.com" },
      }),
    );

    expect(await response.json()).toBeNull();
    expect(await sessionCount(user.id)).toBe(0);
  });

  it("revokes all of the caller's sessions from a trusted origin", async () => {
    const {
      user,
      cookies: [cookie],
    } = await userWithSessions(3);

    const response = await revokeAll(
      post("/api/sgauth/sessions/revoke-all", { cookie, origin: PRODUCT }),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: true });
    expect(await sessionCount(user.id)).toBe(0);
    expiresParentCookie(response.headers.getSetCookie());
    const revoked = await events(user.id, "SESSIONS_REVOKED");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({ metadata: { scope: "all" } });
  });

  it("refuses revoke-all from an unregistered origin", async () => {
    const {
      user,
      cookies: [cookie],
    } = await userWithSessions(3);

    const response = await revokeAll(
      post("/api/sgauth/sessions/revoke-all", {
        cookie,
        origin: "https://unregistered.northeasternsga.com",
      }),
    );

    expect(response.status).toBe(403);
    expect(await sessionCount(user.id)).toBe(3);
  });

  it("revokes every session of a target for an admin, with audit", async () => {
    const { user: target } = await userWithSessions(3);
    const admin = await verifiedUser();

    const result = await revokeAllSessionsForUser({
      prisma,
      targetUserId: target.id,
      actorUserId: admin.id,
    });

    expect(result).toEqual({ revoked: 3 });
    expect(await sessionCount(target.id)).toBe(0);
    const revoked = await events(target.id, "SESSIONS_REVOKED");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      actorUserId: admin.id,
      targetType: "USER",
      targetId: target.id,
      metadata: { scope: "all" },
    });
  });

  it("rolls the revocation back when the audit write fails", async () => {
    const { user: target } = await userWithSessions(3);

    await expect(
      revokeAllSessionsForUser({
        prisma,
        targetUserId: target.id,
        actorUserId: "",
      }),
    ).rejects.toThrow();

    expect(await sessionCount(target.id)).toBe(3);
  });

  it("/logout signs out and audits a same-site request", async () => {
    const {
      user,
      cookies: [cookie],
    } = await userWithSessions(1);

    const response = await logout(
      new Request(`${BASE_URL}/logout?redirect=https://evil.example`, {
        headers: { cookie, "sec-fetch-site": "same-site" },
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe(`${BASE_URL}/login`);
    expiresParentCookie(response.headers.getSetCookie());
    expect(await sessionCount(user.id)).toBe(0);
    expect(await events(user.id, "LOGOUT")).toHaveLength(1);
  });

  it("/logout refuses a cross-site request and keeps the session", async () => {
    const {
      user,
      cookies: [cookie],
    } = await userWithSessions(1);

    const response = await logout(
      new Request(`${BASE_URL}/logout`, {
        headers: { cookie, "sec-fetch-site": "cross-site" },
      }),
    );

    expect(response.status).toBe(403);
    expect(await sessionCount(user.id)).toBe(1);
  });
});
