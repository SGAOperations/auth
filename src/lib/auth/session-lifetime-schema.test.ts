import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { testLockout } from "@/test/lockout-options";
import { SESSION_ABSOLUTE_MAX_AGE_MS } from "@/lib/auth/session-lifetime";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const DAY_MS = 24 * 60 * 60 * 1000;
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!url)("session lifetime", () => {
  // Own client and auth instance, with the real options, as in
  // email-password.test.ts.
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

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  afterEach(() => {
    vi.useRealTimers();
  });

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function verifiedUser() {
    const email = `t39-${counter++}-${rand}@northeastern.edu`;
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    // Verifying signs the user in; these tests expect to open every session.
    await prisma.session.deleteMany({ where: { userId: user.id } });
    return user;
  }

  async function signIn(
    email: string,
    headers: Record<string, string> = {},
  ): Promise<string> {
    const result = await auth.api.signInEmail({
      body: { email, password: STRONG },
      headers: new Headers(headers),
      returnHeaders: true,
    });
    return result.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
  }

  async function signedInUser(headers: Record<string, string> = {}) {
    const user = await verifiedUser();
    const cookie = await signIn(user.email, headers);
    return { user, cookie };
  }

  async function getSession(cookie: string) {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        headers: { cookie },
      }),
    );
    expect(response.status).toBe(200);
    return (await response.json()) as { session: unknown } | null;
  }

  // Goes through sessionMiddleware and getSessionFromCtx, the same path
  // /api/auth/token takes.
  async function listSessionsStatus(cookie: string) {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/list-sessions`, {
        headers: { cookie },
      }),
    );
    return response.status;
  }

  function startClock() {
    vi.useFakeTimers({ toFake: ["Date"] });
    const start = Date.now();
    vi.setSystemTime(start);
    return (offsetMs: number) => vi.setSystemTime(start + offsetMs);
  }

  it("keeps a session used daily valid on day 29 and ends it at the 90-day cap", async () => {
    const at = startClock();
    const { user, cookie } = await signedInUser();

    for (let day = 1; day <= 89; day++) {
      at(day * DAY_MS + HOUR_MS);
      expect(await getSession(cookie)).not.toBeNull();

      if (day === 29) {
        const row = await prisma.session.findFirstOrThrow({
          where: { userId: user.id },
        });
        expect(row.absoluteExpiresAt.getTime() - row.createdAt.getTime()).toBe(
          SESSION_ABSOLUTE_MAX_AGE_MS,
        );
        expect(row.expiresAt.getTime()).toBeGreaterThan(
          row.createdAt.getTime() + 55 * DAY_MS,
        );
      }
    }

    const row = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.expiresAt.getTime()).toBe(row.absoluteExpiresAt.getTime());

    at(90 * DAY_MS + HOUR_MS);
    expect(await listSessionsStatus(cookie)).toBe(401);
    expect(await getSession(cookie)).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    at(91 * DAY_MS);
    expect(await getSession(cookie)).toBeNull();
  }, 300_000);

  it("keeps a session unused for 29 days and ends one unused for 31", async () => {
    const at = startClock();
    const a = await signedInUser();
    const b = await signedInUser();

    at(29 * DAY_MS);
    expect(await getSession(a.cookie)).not.toBeNull();

    at(31 * DAY_MS);
    expect(await listSessionsStatus(b.cookie)).toBe(401);
    expect(await getSession(b.cookie)).toBeNull();
  });

  it("stores the client IP and user agent", async () => {
    const { user } = await signedInUser({
      "x-forwarded-for": "203.0.113.7",
      "user-agent": "SGAuthTest/1.0",
    });
    const row = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.ipAddress).toBe("203.0.113.7");
    expect(row.userAgent).toBe("SGAuthTest/1.0");
  });

  it("does not trust the leftmost hop of a forwarded chain", async () => {
    const { user } = await signedInUser({
      "x-forwarded-for": "203.0.113.7, 10.0.0.1",
    });
    const row = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.ipAddress).not.toBe("203.0.113.7");
  });

  describe("clamp_session_expiry trigger", () => {
    async function rawSession(offsets: { expires: number; absolute: number }) {
      const user = await verifiedUser();
      const createdAt = new Date();
      return prisma.session.create({
        data: {
          token: `t39-${rand}-${counter++}`,
          userId: user.id,
          createdAt,
          expiresAt: new Date(createdAt.getTime() + offsets.expires * DAY_MS),
          absoluteExpiresAt: new Date(
            createdAt.getTime() + offsets.absolute * DAY_MS,
          ),
        },
      });
    }

    it("caps absoluteExpiresAt and expiresAt on insert", async () => {
      const row = await rawSession({ expires: 200, absolute: 200 });
      expect(row.absoluteExpiresAt.getTime()).toBe(
        row.createdAt.getTime() + 90 * DAY_MS,
      );
      expect(row.expiresAt.getTime()).toBe(row.absoluteExpiresAt.getTime());
    });

    it("never lets absoluteExpiresAt move later", async () => {
      const row = await rawSession({ expires: 30, absolute: 90 });
      const updated = await prisma.session.update({
        where: { id: row.id },
        data: {
          absoluteExpiresAt: new Date(row.createdAt.getTime() + 200 * DAY_MS),
        },
      });
      expect(updated.absoluteExpiresAt.getTime()).toBe(
        row.absoluteExpiresAt.getTime(),
      );
    });

    it("clamps an expiresAt written past the cap", async () => {
      const row = await rawSession({ expires: 30, absolute: 90 });
      const updated = await prisma.session.update({
        where: { id: row.id },
        data: { expiresAt: new Date(row.createdAt.getTime() + 150 * DAY_MS) },
      });
      expect(updated.expiresAt.getTime()).toBe(
        updated.absoluteExpiresAt.getTime(),
      );
    });

    it("lets the cap be shortened and pulls expiresAt down with it", async () => {
      const row = await rawSession({ expires: 30, absolute: 90 });
      const shortened = new Date(row.createdAt.getTime() + 1 * DAY_MS);
      const updated = await prisma.session.update({
        where: { id: row.id },
        data: { absoluteExpiresAt: shortened },
      });
      expect(updated.absoluteExpiresAt.getTime()).toBe(shortened.getTime());
      expect(updated.expiresAt.getTime()).toBe(shortened.getTime());
    });
  });
});
