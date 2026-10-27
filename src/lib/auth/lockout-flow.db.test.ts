import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { audit } from "@/lib/audit";
import { buildAuthOptions } from "@/lib/auth/options";
import { createUnlockConsumer, loadUnlockView } from "@/lib/auth/unlock";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import { createCapturingMailer } from "@/test/capturing-mailer";
import { useFakeClock } from "@/test/fake-clock";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const WRONG = "not-the-right-password";
const DEVICE_COOKIE = "sgauth-local.device";
const MINUTE_MS = 60 * 1000;

describe.skipIf(!url)("account lockout through Better Auth", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const mailer = createCapturingMailer();
  const deviceCookie = { name: DEVICE_COOKIE, secure: false };
  // The real options, with the inline defer: counting finishes before the
  // response returns, so the tests can assert straight after a sign-in.
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: { mailer, deviceCookie },
    }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t64-${counter++}-${rand}@northeastern.edu`;
  const resetIdentifiers: string[] = [];

  let clock: ReturnType<typeof useFakeClock> | null = null;
  afterEach(() => {
    clock?.restore();
    clock = null;
    vi.restoreAllMocks();
  });

  // Audit rows cannot be deleted, so assertions filter by this run's users.
  afterAll(async () => {
    await prisma.verification.deleteMany({
      where: { identifier: { in: resetIdentifiers } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function verifiedUser() {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Lockout Test" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    return { email, user };
  }

  function signIn(
    email: string,
    password: string,
    cookie?: string,
    instance: typeof auth = auth,
  ) {
    return instance.handler(
      new Request(`${BASE_URL}/api/auth/sign-in/email`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          ...(cookie ? { cookie } : {}),
        },
        body: JSON.stringify({ email, password }),
      }),
    );
  }

  const deviceCookieOf = (response: Response) =>
    response.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${DEVICE_COOKIE}=`))
      ?.split(";")[0];

  async function failTimes(email: string, times: number, cookie?: string) {
    for (let i = 0; i < times; i++) {
      expect((await signIn(email, WRONG, cookie)).status).toBe(401);
    }
  }

  const events = async (userId: string, type: string) =>
    prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
    });

  const tokenFromEmail = (email: string) => {
    const sent = mailer
      .to(email)
      .filter((message) => message.template === "account-unlock")
      .at(-1);
    const link = new URL(String(sent?.data.url));
    return { link, token: link.searchParams.get("token") ?? "" };
  };

  const confirmHandler = createTokenActionHandler({
    action: "account-unlock",
    consume: createUnlockConsumer({
      prisma,
      onUnlocked: async (tx, userId) => {
        await audit(
          {
            type: "ACCOUNT_UNLOCKED",
            actorType: "USER",
            actorUserId: userId,
            targetType: "USER",
            targetId: userId,
            metadata: { method: "email_link" },
          },
          { db: tx },
        );
      },
    }),
    limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    log: { error: vi.fn() },
  });

  const confirm = (token: string) =>
    confirmHandler(
      new Request(`${BASE_URL}/unlock/confirm`, {
        method: "POST",
        headers: {
          "content-type": "application/x-www-form-urlencoded",
          origin: BASE_URL,
        },
        body: new URLSearchParams({ token }).toString(),
      }),
    );

  const resultOf = (response: Response) =>
    new URL(response.headers.get("location") ?? "").searchParams.get("result");

  // AC1
  it("refuses the sixth attempt even with the right password, and the unlock link restores access", async () => {
    const { email, user } = await verifiedUser();

    await failTimes(email, 5);
    const refused = await signIn(email, STRONG);
    expect(refused.status).toBe(401);
    expect(await refused.json()).toMatchObject({
      code: "INVALID_EMAIL_OR_PASSWORD",
    });

    expect(await events(user.id, "ACCOUNT_LOCKED")).toHaveLength(1);
    const failures = await events(user.id, "LOGIN_FAILED");
    expect(
      failures.filter(
        (event) =>
          (event.metadata as { reason?: string }).reason === "ACCOUNT_LOCKED",
      ),
    ).toHaveLength(1);

    const templates = mailer.to(email).map((message) => message.template);
    expect(templates).toContain("account-locked");
    expect(templates.filter((name) => name === "account-unlock")).toHaveLength(
      1,
    );

    const { link, token } = tokenFromEmail(email);
    expect(link.pathname).toBe("/unlock");

    // The page's GET reads and consumes nothing.
    expect(await loadUnlockView({ token }, prisma)).toEqual({
      state: "ready",
      token,
    });
    const row = await prisma.unlockToken.findFirstOrThrow({
      where: { userId: user.id },
    });
    expect(row.usedAt).toBeNull();

    expect(resultOf(await confirm(token))).toBe("done");
    const unlocked = await events(user.id, "ACCOUNT_UNLOCKED");
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].metadata).toEqual({ method: "email_link" });

    expect((await signIn(email, STRONG)).status).toBe(200);
    expect(resultOf(await confirm(token))).toBe("invalid");
  });

  it("answers an unknown, used or malformed unlock token the same way", async () => {
    expect(resultOf(await confirm("no-such-token"))).toBe("invalid");
    expect(await loadUnlockView({ token: "no-such-token" }, prisma)).toEqual({
      state: "invalid",
    });
    expect(await loadUnlockView({}, prisma)).toEqual({ state: "invalid" });
  });

  // AC2
  it("lets a known-device cookie sign in while the account is locked", async () => {
    const { email, user } = await verifiedUser();
    const first = await signIn(email, STRONG);
    expect(first.status).toBe(200);
    const cookie = deviceCookieOf(first);
    expect(cookie).toBeDefined();

    const setCookie = first.headers
      .getSetCookie()
      .find((entry) => entry.startsWith(`${DEVICE_COOKIE}=`))!;
    expect(setCookie).toMatch(/HttpOnly/i);
    expect(setCookie).toMatch(/SameSite=Lax/i);
    expect(setCookie).toMatch(/Max-Age=31536000/);
    expect(setCookie).not.toMatch(/Domain=/i);

    await failTimes(email, 5);
    expect((await signIn(email, STRONG)).status).toBe(401);

    const withCookie = await signIn(email, STRONG, cookie);
    expect(withCookie.status).toBe(200);
    expect((await signIn(email, STRONG)).status).toBe(401);

    const lock = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(lock.lockedUntil).not.toBeNull();
  });

  it("treats a tampered cookie or another user's cookie as unknown", async () => {
    const mine = await verifiedUser();
    const theirs = await verifiedUser();
    const ownCookie = deviceCookieOf(await signIn(mine.email, STRONG))!;
    const otherCookie = deviceCookieOf(await signIn(theirs.email, STRONG))!;

    await failTimes(mine.email, 5);

    const tampered = ownCookie.replace("=", "=X");
    expect((await signIn(mine.email, STRONG, tampered)).status).toBe(401);
    expect((await signIn(mine.email, STRONG, otherCookie)).status).toBe(401);
    expect((await signIn(mine.email, STRONG, ownCookie)).status).toBe(200);
  });

  it("locks a device on its own counter and leaves the account alone", async () => {
    const { email, user } = await verifiedUser();
    const cookie = deviceCookieOf(await signIn(email, STRONG))!;

    await failTimes(email, 5, cookie);

    expect(
      await prisma.accountLock.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
    expect((await signIn(email, STRONG, cookie)).status).toBe(401);
    expect(await events(user.id, "ACCOUNT_LOCKED")).toHaveLength(0);
    // The browser without the cookie is not affected.
    expect((await signIn(email, STRONG)).status).toBe(200);
  });

  // AC3
  it("escalates the second lock to 30 minutes after the first expires", async () => {
    clock = useFakeClock("2026-06-01T12:00:00Z");
    const { email, user } = await verifiedUser();

    await failTimes(email, 5);
    clock.advance(15 * MINUTE_MS + 1000);
    expect((await signIn(email, STRONG)).status).toBe(200);

    await failTimes(email, 5);
    const lock = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: user.id },
    });
    expect(lock.lockedUntil!.getTime() - clock.now().getTime()).toBe(
      30 * MINUTE_MS,
    );
    expect(lock.lockLevel).toBe(2);
  });

  // AC4
  it("gives an unknown email, a wrong password and a locked account the same response and one hash each", async () => {
    const unknown = freshEmail();
    const wrong = await verifiedUser();
    const locked = await verifiedUser();
    await failTimes(locked.email, 5);

    const { password } = await auth.$context;
    const hash = vi.spyOn(password, "hash");
    const verify = vi.spyOn(password, "verify");
    const kdfCalls = () => hash.mock.calls.length + verify.mock.calls.length;

    const outcomes: { status: number; body: string; kdf: number }[] = [];
    for (const [email, pw] of [
      [unknown, STRONG],
      [wrong.email, WRONG],
      [locked.email, STRONG],
    ] as const) {
      hash.mockClear();
      verify.mockClear();
      const response = await signIn(email, pw);
      outcomes.push({
        status: response.status,
        body: await response.text(),
        kdf: kdfCalls(),
      });
    }

    expect(outcomes.map((outcome) => outcome.status)).toEqual([401, 401, 401]);
    expect(new Set(outcomes.map((outcome) => outcome.body)).size).toBe(1);
    expect(outcomes.map((outcome) => outcome.kdf)).toEqual([1, 1, 1]);
  });

  it("writes nothing before the response, for a known or an unknown email", async () => {
    const held: (() => Promise<void>)[] = [];
    const deferred = betterAuth(
      buildAuthOptions({
        prisma,
        baseURL: BASE_URL,
        secret: SECRET,
        lockout: {
          mailer,
          deviceCookie,
          defer: (task) => {
            held.push(task);
          },
        },
      }),
    );
    const known = await verifiedUser();

    expect((await signIn(known.email, WRONG, undefined, deferred)).status).toBe(
      401,
    );
    expect(
      (await signIn(freshEmail(), WRONG, undefined, deferred)).status,
    ).toBe(401);
    expect(
      await prisma.accountLock.findUnique({ where: { userId: known.user.id } }),
    ).toBeNull();

    for (const task of held) await task();
    const row = await prisma.accountLock.findUniqueOrThrow({
      where: { userId: known.user.id },
    });
    expect(row.failedCount).toBe(1);
  });

  it("lifts the lock on a password reset and audits it only when it was locked", async () => {
    async function reset(userId: string) {
      const token = `t64-reset-${counter++}-${rand}`;
      const identifier = `reset-password:${token}`;
      resetIdentifiers.push(identifier);
      await prisma.verification.create({
        data: {
          identifier,
          value: userId,
          expiresAt: new Date(Date.now() + 60 * MINUTE_MS),
        },
      });
      await auth.api.resetPassword({
        body: { newPassword: "a-brand-new-password-1", token },
      });
    }

    const locked = await verifiedUser();
    await failTimes(locked.email, 5);
    await reset(locked.user.id);

    const unlocked = await events(locked.user.id, "ACCOUNT_UNLOCKED");
    expect(unlocked).toHaveLength(1);
    expect(unlocked[0].metadata).toEqual({ method: "password_reset" });
    expect((await signIn(locked.email, "a-brand-new-password-1")).status).toBe(
      200,
    );

    const open = await verifiedUser();
    await reset(open.user.id);
    expect(await events(open.user.id, "ACCOUNT_UNLOCKED")).toHaveLength(0);
  });

  it("does not count a sign-in refused for an unverified email", async () => {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Unverified" },
    });
    for (let i = 0; i < 6; i++) {
      expect((await signIn(email, STRONG)).status).toBe(403);
    }
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(
      await prisma.accountLock.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
  });
});
