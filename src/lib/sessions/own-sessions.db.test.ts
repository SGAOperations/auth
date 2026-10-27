import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { testLockout } from "@/test/lockout-options";
import {
  betterAuthSessionDeps,
  createOwnSessionHandlers,
} from "@/lib/sessions/own-sessions";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";

describe.skipIf(!url)("own session endpoints", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: testLockout(),
    }),
  );
  const handlers = createOwnSessionHandlers(
    betterAuthSessionDeps(auth, prisma),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function verifiedUser() {
    const email = `t45-${counter++}-${rand}@northeastern.edu`;
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    // Verifying signs the user in; these tests count the sessions they open.
    await prisma.session.deleteMany({ where: { userId: user.id } });
    return { email, user };
  }

  async function signIn(email: string, userAgent: string, ip: string) {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          "user-agent": userAgent,
          "x-forwarded-for": ip,
        },
        body: JSON.stringify({ email, password: STRONG }),
      }),
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
  }

  const CHROME_MAC =
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";
  const FIREFOX_WIN =
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:127.0) Gecko/20100101 Firefox/127.0";

  const get = (cookie?: string) =>
    handlers.list(
      new Request(`${BASE_URL}/api/sgauth/sessions`, {
        headers: cookie ? { cookie } : {},
      }),
    );

  const del = (id: string, headers: Record<string, string>) =>
    handlers.revoke(
      new Request(`${BASE_URL}/api/sgauth/sessions/${id}`, {
        method: "DELETE",
        headers,
      }),
      id,
    );

  async function twoSessions() {
    const { email, user } = await verifiedUser();
    const cookie1 = await signIn(email, CHROME_MAC, "203.0.113.1");
    const cookie2 = await signIn(email, FIREFOX_WIN, "203.0.113.2");
    const rows = await prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    return { email, user, cookie1, cookie2, id1: rows[0].id, id2: rows[1].id };
  }

  function revokedEvents(userId: string) {
    return prisma.auditEvent.findMany({
      where: { type: "SESSION_REVOKED", actorUserId: userId },
    });
  }

  it("lists only the caller's live sessions, current first, with no token", async () => {
    const a = await twoSessions();
    const b = await verifiedUser();
    await signIn(b.email, CHROME_MAC, "203.0.113.3");
    await prisma.session.create({
      data: {
        token: `expired-${rand}`,
        userId: a.user.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const response = await get(a.cookie1);
    expect(response.status).toBe(200);
    const body = (await response.json()) as {
      sessions: Array<Record<string, unknown>>;
    };

    expect(body.sessions.map((s) => s.id)).toEqual([a.id1, a.id2]);
    expect(body.sessions[0]).toMatchObject({
      isCurrent: true,
      device: "Chrome on macOS",
      ip: "203.0.113.1",
    });
    expect(body.sessions[1]).toMatchObject({
      isCurrent: false,
      device: "Firefox on Windows",
    });
    for (const s of body.sessions) {
      expect(Object.keys(s)).not.toContain("token");
      expect(new Date(s.createdAt as string).toISOString()).toBe(s.createdAt);
    }
    const bIds = (
      await prisma.session.findMany({ where: { userId: b.user.id } })
    ).map((s) => s.id);
    expect(body.sessions.some((s) => bIds.includes(s.id as string))).toBe(
      false,
    );
  });

  it("returns 401 with no cookie and for a deactivated user", async () => {
    expect((await get()).status).toBe(401);

    const { email, user } = await verifiedUser();
    const cookie = await signIn(email, CHROME_MAC, "203.0.113.4");
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DEACTIVATED" },
    });
    expect((await get(cookie)).status).toBe(401);
  });

  it("revokes another of the caller's own sessions and audits it once", async () => {
    const a = await twoSessions();

    const response = await del(a.id2, {
      cookie: a.cookie1,
      origin: BASE_URL,
    });
    expect(response.status).toBe(204);
    expect(response.headers.getSetCookie()).toHaveLength(0);
    expect(
      await prisma.session.findUnique({ where: { id: a.id2 } }),
    ).toBeNull();

    const events = await revokedEvents(a.user.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetType: "SESSION",
      targetId: a.id2,
      actorUserId: a.user.id,
    });
    expect((await get(a.cookie2)).status).toBe(401);
  });

  it("returns an identical 404 for anything that is not the caller's live session", async () => {
    const a = await twoSessions();
    const b = await verifiedUser();
    await signIn(b.email, CHROME_MAC, "203.0.113.5");
    const bRow = await prisma.session.findFirstOrThrow({
      where: { userId: b.user.id },
    });
    const expired = await prisma.session.create({
      data: {
        token: `expired-${rand}-404`,
        userId: a.user.id,
        expiresAt: new Date(Date.now() - 60_000),
      },
    });

    const pastCap = await prisma.session.create({
      data: {
        token: `past-cap-${rand}-404`,
        userId: a.user.id,
        expiresAt: new Date(Date.now() + 60_000),
        absoluteExpiresAt: new Date(Date.now() - 60_000),
      },
    });

    const ids = [
      bRow.id,
      "0190a000-0000-7000-8000-00000000dead",
      expired.id,
      pastCap.id,
    ];
    ids.push("not-a-uuid");
    const results = [];
    for (const id of ids) {
      const response = await del(id, { cookie: a.cookie1, origin: BASE_URL });
      expect(response.status).toBe(404);
      results.push(await response.text());
    }
    expect(new Set(results).size).toBe(1);

    expect(
      await prisma.session.findUnique({ where: { id: bRow.id } }),
    ).not.toBeNull();
    expect(await revokedEvents(a.user.id)).toHaveLength(0);
    expect(await revokedEvents(b.user.id)).toHaveLength(0);
  });

  it("clears the cookie when the current session is revoked", async () => {
    const a = await twoSessions();

    const response = await del(a.id1, { cookie: a.cookie1, origin: BASE_URL });
    expect(response.status).toBe(204);

    const { authCookies } = await auth.$context;
    const cleared = response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${authCookies.sessionToken.name}=`));
    expect(cleared).toContain("Max-Age=0");
    expect(
      await prisma.session.findUnique({ where: { id: a.id1 } }),
    ).toBeNull();
    expect((await get(a.cookie1)).status).toBe(401);
  });

  it("enforces Origin on DELETE", async () => {
    const a = await twoSessions();

    expect((await del(a.id2, { cookie: a.cookie1 })).status).toBe(403);
    expect(
      (await del(a.id2, { cookie: a.cookie1, origin: "https://evil.example" }))
        .status,
    ).toBe(403);
    expect(
      await prisma.session.findUnique({ where: { id: a.id2 } }),
    ).not.toBeNull();
    expect(await revokedEvents(a.user.id)).toHaveLength(0);

    const viaReferer = await del(a.id2, {
      cookie: a.cookie1,
      referer: `${BASE_URL}/account`,
    });
    expect(viaReferer.status).toBe(204);
  });
});
