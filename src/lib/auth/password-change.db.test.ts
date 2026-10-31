import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildAuthPlugins } from "@/lib/auth/plugins";
import { REAUTH_WINDOW_MS } from "@/lib/auth/reauth-policy";
import { createRateLimiter } from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import { testLockout } from "@/test/lockout-options";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const WRONG = "not-the-right-password";
const NEW_PASSWORD = "a-brand-new-password-9";
const DEVICE_COOKIE = "sgauth-local.device";

describe.skipIf(!url)("change password (AUTH-T23)", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL. The options
  // and plugins are the real ones, so the real hooks run, the re-auth gate
  // included. Each test uses its own user, so the per-user limit never leaks
  // between cases.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const lockout = testLockout();
  const auth = betterAuth({
    ...buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout,
      rateLimiter: createRateLimiter({
        backend: createMemoryBackend(),
        log: { error() {} },
      }),
    }),
    plugins: buildAuthPlugins({
      signupAllowlist: null,
      passkey: { rpID: "localhost", rpName: "Test", origin: BASE_URL },
      prisma,
      issuer: BASE_URL,
      secret: SECRET,
      sgauthEnv: "local",
      mailer: lockout.mailer,
    }),
  });

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t23-${counter++}-${rand}@northeastern.edu`;

  // Audit rows cannot be deleted, so every assertion filters by this run's
  // users.
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  // Folds a response's Set-Cookie headers into a request Cookie header value.
  function mergeCookies(existing: string, response: Response): string {
    const jar = new Map<string, string>();
    for (const pair of existing ? existing.split("; ") : []) {
      const at = pair.indexOf("=");
      jar.set(pair.slice(0, at), pair.slice(at + 1));
    }
    for (const entry of response.headers.getSetCookie()) {
      const [pair, ...attributes] = entry.split(";");
      const at = pair.indexOf("=");
      const name = pair.slice(0, at);
      const value = pair.slice(at + 1);
      const expired = attributes.some((a) => /^\s*max-age=0\s*$/i.test(a));
      if (expired || value === "") jar.delete(name);
      else jar.set(name, value);
    }
    return [...jar].map(([name, value]) => `${name}=${value}`).join("; ");
  }

  // The same cookies without the known-device one: an unfamiliar browser.
  const withoutDevice = (cookie: string) =>
    cookie
      .split("; ")
      .filter((pair) => !pair.startsWith(`${DEVICE_COOKIE}=`))
      .join("; ");

  function post(path: string, body: unknown, cookie = "") {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify(body),
      }),
    );
  }

  const changePassword = (cookie: string, body: Record<string, unknown> = {}) =>
    post(
      "/change-password",
      { currentPassword: STRONG, newPassword: NEW_PASSWORD, ...body },
      cookie,
    );

  // What POST /api/sgauth/reauth hands to the plugin endpoint.
  const reauth = (cookie: string) =>
    auth.api.sgauthReauthenticate({
      headers: new Headers({ cookie }),
      body: { password: STRONG },
      asResponse: true,
    });

  async function verifiedUser() {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Change Password Test" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    return {
      email,
      user: await prisma.user.findUniqueOrThrow({ where: { email } }),
    };
  }

  async function signIn(email: string, password = STRONG) {
    const response = await post("/sign-in/email", { email, password });
    expect(response.status).toBe(200);
    return mergeCookies("", response);
  }

  async function sessionIdOf(cookie: string) {
    const response = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        headers: { cookie },
      }),
    );
    const body: { session: { id: string } } = await response.json();
    return body.session.id;
  }

  const stampSessions = (userId: string, at = new Date()) =>
    prisma.session.updateMany({
      where: { userId },
      data: { lastReauthAt: at },
    });

  const passwordHashOf = async (userId: string) =>
    (
      await prisma.account.findFirstOrThrow({
        where: { userId, providerId: "credential" },
      })
    ).password;

  const lockOf = (userId: string) =>
    prisma.accountLock.findUnique({ where: { userId } });

  function eventsFor(userId: string, type: string) {
    return prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
      orderBy: { createdAt: "asc" },
    });
  }

  const noticesTo = (email: string) =>
    lockout.mailer
      .to(email)
      .filter(
        (message) =>
          message.template === "security-notice" &&
          message.data.event === "password-changed",
      );

  it("logs out every other device and keeps the caller's session (two sessions)", async () => {
    const { email, user } = await verifiedUser();
    const a = await signIn(email);
    const b = await signIn(email);
    await signIn(email);
    const sessionA = await sessionIdOf(a);
    expect((await reauth(a)).status).toBe(200);
    const before = await prisma.session.findUniqueOrThrow({
      where: { id: sessionA },
    });
    const loginsBefore = (await eventsFor(user.id, "LOGIN_SUCCESS")).length;
    const hashBefore = await passwordHashOf(user.id);

    // A client-sent `true` is ignored: SGAuth revokes the others itself.
    const response = await changePassword(a, { revokeOtherSessions: true });
    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({ token: null });

    const other = await auth.handler(
      new Request(`${BASE_URL}/api/auth/get-session`, {
        headers: { cookie: b },
      }),
    );
    expect(await other.json()).toBeNull();

    const remaining = await prisma.session.findMany({
      where: { userId: user.id },
    });
    expect(remaining).toHaveLength(1);
    expect(remaining[0]).toMatchObject({
      id: sessionA,
      absoluteExpiresAt: before.absoluteExpiresAt,
      lastReauthAt: before.lastReauthAt,
    });
    expect(await passwordHashOf(user.id)).not.toBe(hashBefore);

    const changed = await prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(changed.passwordChangedAt).not.toBeNull();
    expect(await eventsFor(user.id, "PASSWORD_CHANGED")).toMatchObject([
      { metadata: { revokedOtherSessions: true } },
    ]);
    expect(await eventsFor(user.id, "LOGIN_SUCCESS")).toHaveLength(
      loginsBefore,
    );
    expect(noticesTo(email)).toHaveLength(1);

    const old = await post("/sign-in/email", { email, password: STRONG });
    expect(old.status).toBe(401);
    expect(
      (await post("/sign-in/email", { email, password: NEW_PASSWORD })).status,
    ).toBe(200);
  });

  describe("lockout", () => {
    it("counts wrong current passwords, locks, and refuses even the right one", async () => {
      const { email, user } = await verifiedUser();
      const cookie = withoutDevice(await signIn(email));
      await stampSessions(user.id);
      lockout.mailer.clear();
      const hashBefore = await passwordHashOf(user.id);
      const sessionsBefore = await prisma.session.count({
        where: { userId: user.id },
      });

      const first = await changePassword(cookie, { currentPassword: WRONG });
      expect(first.status).toBe(400);
      expect(await first.json()).toMatchObject({ code: "INVALID_PASSWORD" });
      expect((await lockOf(user.id))?.failedCount).toBe(1);
      expect(await eventsFor(user.id, "PASSWORD_CHANGE_FAILED")).toMatchObject([
        { metadata: { reason: "INVALID_CURRENT_PASSWORD" } },
      ]);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
        sessionsBefore,
      );
      expect(await passwordHashOf(user.id)).toBe(hashBefore);

      for (let i = 0; i < 4; i++) {
        const response = await changePassword(cookie, {
          currentPassword: WRONG,
        });
        expect(response.status).toBe(400);
      }
      expect((await lockOf(user.id))?.lockedUntil).not.toBeNull();
      expect(await eventsFor(user.id, "ACCOUNT_LOCKED")).toHaveLength(1);
      expect(
        lockout.mailer.to(email).map((message) => message.template),
      ).toEqual(expect.arrayContaining(["account-locked", "account-unlock"]));

      // Six requests in all, under the limit of ten.
      const refused = await changePassword(cookie);
      expect(refused.status).toBe(403);
      expect(await refused.json()).toMatchObject({
        code: "PASSWORD_CHANGE_LOCKED",
      });
      expect(await passwordHashOf(user.id)).toBe(hashBefore);
      expect(await eventsFor(user.id, "PASSWORD_CHANGE_FAILED")).toHaveLength(
        6,
      );
      expect(
        (await eventsFor(user.id, "PASSWORD_CHANGE_FAILED")).filter(
          (event) =>
            (event.metadata as { reason?: string } | null)?.reason ===
            "ACCOUNT_LOCKED",
        ),
      ).toHaveLength(1);

      // The lock is shared with sign-in.
      const signInRefused = await post("/sign-in/email", {
        email,
        password: STRONG,
      });
      expect(signInRefused.status).toBe(401);
    });

    it("resets the failure counter on a successful change", async () => {
      const { email, user } = await verifiedUser();
      const cookie = withoutDevice(await signIn(email));
      await stampSessions(user.id);
      await changePassword(cookie, { currentPassword: WRONG });
      await changePassword(cookie, { currentPassword: WRONG });
      expect((await lockOf(user.id))?.failedCount).toBe(2);

      expect((await changePassword(cookie)).status).toBe(200);
      expect((await lockOf(user.id))?.failedCount).toBe(0);
    });
  });

  describe("rate limit", () => {
    it("answers 429 after ten requests, without verifying, counting or auditing", async () => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);
      await stampSessions(user.id);
      const hashBefore = await passwordHashOf(user.id);

      for (let i = 0; i < 10; i++) {
        const response = await changePassword(cookie, {
          newPassword: STRONG,
        });
        expect(response.status).toBe(400);
        expect(await response.json()).toMatchObject({
          code: "NEW_PASSWORD_SAME_AS_CURRENT",
        });
      }

      const limited = await changePassword(cookie);
      expect(limited.status).toBe(429);
      expect(await limited.json()).toMatchObject({
        code: "TOO_MANY_REQUESTS",
      });
      expect(Number(limited.headers.get("retry-after"))).toBeGreaterThanOrEqual(
        1,
      );
      expect(limited.headers.get("cache-control")).toBe("no-store");

      expect(await passwordHashOf(user.id)).toBe(hashBefore);
      expect(await lockOf(user.id)).toBeNull();
      expect(await eventsFor(user.id, "PASSWORD_CHANGE_FAILED")).toHaveLength(
        0,
      );
      expect(await eventsFor(user.id, "PASSWORD_CHANGED")).toHaveLength(0);

      // The budget is per user.
      const other = await verifiedUser();
      const otherCookie = await signIn(other.email);
      await stampSessions(other.user.id);
      expect((await changePassword(otherCookie)).status).toBe(200);
    });

    it("leaves a trusted server-side call unlimited", async () => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);
      await stampSessions(user.id);

      for (let i = 0; i < 11; i++) {
        // A too-short password is refused before the same-password check, so
        // each call fails on its own validation and never on the limiter.
        await expect(
          auth.api.changePassword({
            headers: new Headers({ cookie }),
            body: { currentPassword: STRONG, newPassword: "short" },
          }),
        ).rejects.toMatchObject({
          statusCode: 400,
          body: { code: "PASSWORD_TOO_SHORT" },
        });
      }
    });
  });

  describe("re-auth gate", () => {
    it.each([
      ["no re-auth", null],
      [
        "a re-auth 11 minutes old",
        new Date(Date.now() - REAUTH_WINDOW_MS - 60_000),
      ],
    ])("answers 403 REAUTH_REQUIRED for %s", async (_name, at) => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);
      if (at) await stampSessions(user.id, at);

      const response = await changePassword(cookie, { currentPassword: WRONG });
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      // The after hook did not run.
      expect(await lockOf(user.id)).toBeNull();
      expect(await eventsFor(user.id, "PASSWORD_CHANGE_FAILED")).toHaveLength(
        0,
      );
    });
  });

  it("refuses the same password without counting it", async () => {
    const { email, user } = await verifiedUser();
    const cookie = await signIn(email);
    await stampSessions(user.id);

    const response = await changePassword(cookie, { newPassword: STRONG });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({
      code: "NEW_PASSWORD_SAME_AS_CURRENT",
    });
    expect(await lockOf(user.id)).toBeNull();
  });

  it("counts nothing for a too-short new password", async () => {
    const { email, user } = await verifiedUser();
    const cookie = await signIn(email);
    await stampSessions(user.id);

    const response = await changePassword(cookie, { newPassword: "short" });
    expect(response.status).toBe(400);
    expect(await response.json()).toMatchObject({ code: "PASSWORD_TOO_SHORT" });
    expect(await lockOf(user.id)).toBeNull();
    expect(await eventsFor(user.id, "PASSWORD_CHANGE_FAILED")).toHaveLength(0);
  });
});
