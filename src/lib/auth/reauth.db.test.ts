import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createFreshAuthGuard } from "@/lib/auth/fresh-auth";
import { buildAuthOptions } from "@/lib/auth/options";
import { buildAuthPlugins } from "@/lib/auth/plugins";
import {
  FRESH_AUTH_AUTH_PATHS,
  type ReauthBody,
} from "@/lib/auth/reauth-policy";
import { currentTotpStep, hotp } from "@/lib/auth/totp";
import { testLockout } from "@/test/lockout-options";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const WRONG = "not-the-right-password";
const DEVICE_COOKIE = "sgauth-local.device";
const MINUTE_MS = 60 * 1000;

describe.skipIf(!url)("re-authentication (sudo mode)", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL. The options
  // and plugins are the real ones, so the real hooks run.
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
    }),
    plugins: buildAuthPlugins({
      signupAllowlist: null,
      prisma,
      issuer: BASE_URL,
      secret: SECRET,
      sgauthEnv: "local",
      mailer: lockout.mailer,
    }),
  });
  const guard = createFreshAuthGuard({
    getSession: (headers) => auth.api.getSession({ headers }),
    prisma,
  });

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t32-${counter++}-${rand}@northeastern.edu`;

  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Audit rows cannot be deleted, so every assertion filters by this run's
  // users. A user's sessions and TwoFactor row go with it.
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

  // What POST /api/sgauth/reauth hands to the plugin endpoint.
  function reauth(cookie: string, body: ReauthBody) {
    return auth.api.sgauthReauthenticate({
      headers: new Headers({ cookie }),
      body,
      asResponse: true,
    });
  }

  async function verifiedUser() {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Reauth Test" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    return {
      email,
      user: await prisma.user.findUniqueOrThrow({ where: { email } }),
    };
  }

  async function signIn(email: string) {
    const response = await post("/sign-in/email", { email, password: STRONG });
    expect(response.status).toBe(200);
    return mergeCookies("", response);
  }

  const latestSession = (userId: string) =>
    prisma.session.findFirstOrThrow({
      where: { userId },
      orderBy: { createdAt: "desc" },
    });

  // Sets the stamp as if the re-auth happened `ageMs` ago. The suite never
  // waits: the unit tests pin the boundaries, this one the wiring.
  const backdate = (sessionId: string, ageMs: number) =>
    prisma.session.update({
      where: { id: sessionId },
      data: { lastReauthAt: new Date(Date.now() - ageMs) },
    });

  // A gated endpoint is reached for setup by stamping the user's sessions.
  const stampSessions = (userId: string) =>
    prisma.session.updateMany({
      where: { userId },
      data: { lastReauthAt: new Date() },
    });

  function eventsFor(userId: string, type: string) {
    return prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
      orderBy: { createdAt: "asc" },
    });
  }

  async function totpSecretOf(userId: string) {
    const row = await prisma.twoFactor.findFirstOrThrow({ where: { userId } });
    return symmetricDecrypt({
      key: (await auth.$context).secretConfig,
      data: row.secret,
    });
  }

  // One step after the current one: enrollment consumed the current step, and
  // this is still inside the accepted window.
  const nextCode = (totpSecret: string) =>
    hotp(totpSecret, currentTotpStep(Date.now()) + 1);

  async function enrolledUser() {
    const { email, user } = await verifiedUser();
    let cookie = await signIn(email);
    await stampSessions(user.id);
    const enable = await post(
      "/two-factor/enable",
      { password: STRONG },
      cookie,
    );
    expect(enable.status).toBe(200);
    const enabled: { backupCodes: string[] } = await enable.json();
    const totpSecret = await totpSecretOf(user.id);
    const verify = await post(
      "/two-factor/verify-totp",
      { code: hotp(totpSecret, currentTotpStep(Date.now())) },
      cookie,
    );
    expect(verify.status).toBe(200);
    cookie = mergeCookies(cookie, verify);
    return {
      email,
      user,
      totpSecret,
      backupCodes: enabled.backupCodes,
      cookie,
    };
  }

  // The second step of an enrolled user's sign-in, with a TOTP.
  async function signInWithTotp(email: string, code: string) {
    const first = await post("/sign-in/email", { email, password: STRONG });
    expect(await first.json()).toMatchObject({ twoFactorRedirect: true });
    const challenge = mergeCookies("", first);
    const second = await post("/two-factor/verify-totp", { code }, challenge);
    expect(second.status).toBe(200);
    return mergeCookies(challenge, second);
  }

  describe("the 10 minute window", () => {
    it("gates a sensitive endpoint until re-auth, then for 10 minutes", async () => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);

      const blocked = await post("/revoke-other-sessions", {}, cookie);
      expect(blocked.status).toBe(403);
      expect(await blocked.json()).toMatchObject({ code: "REAUTH_REQUIRED" });

      const response = await reauth(cookie, { password: STRONG });
      expect(response.status).toBe(200);
      const body: { status: boolean; freshUntil: string } =
        await response.json();
      expect(body.status).toBe(true);
      expect(new Date(body.freshUntil).getTime()).toBeGreaterThan(Date.now());
      const session = await latestSession(user.id);
      expect(session.lastReauthAt).not.toBeNull();

      await backdate(session.id, 9 * MINUTE_MS);
      expect((await post("/revoke-other-sessions", {}, cookie)).status).toBe(
        200,
      );
      expect((await guard(new Headers({ cookie }))).ok).toBe(true);

      await backdate(session.id, 11 * MINUTE_MS);
      const stale = await post("/revoke-other-sessions", {}, cookie);
      expect(stale.status).toBe(403);
      expect(await stale.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      const staleGuard = await guard(new Headers({ cookie }));
      expect(staleGuard.ok).toBe(false);
      if (!staleGuard.ok) expect(staleGuard.response.status).toBe(403);
    });

    it("stamps only the caller's own session", async () => {
      const { email, user } = await verifiedUser();
      const first = await signIn(email);
      await signIn(email);
      const target = await prisma.session.findFirstOrThrow({
        where: { userId: user.id },
        orderBy: { createdAt: "desc" },
      });
      // The cookie of the older session.
      await reauth(first, { password: STRONG });

      const stamped = await prisma.session.findMany({
        where: { userId: user.id, lastReauthAt: { not: null } },
      });
      expect(stamped).toHaveLength(1);
      expect(stamped[0].id).not.toBe(target.id);
    });

    it("answers 401 with no session", async () => {
      const response = await auth.api.sgauthReauthenticate({
        headers: new Headers(),
        body: { password: STRONG },
        asResponse: true,
      });
      expect(response.status).toBe(401);
    });

    it("writes REAUTH_SUCCEEDED with only the method", async () => {
      const { email, user } = await verifiedUser();
      await reauth(await signIn(email), { password: STRONG });
      const events = await eventsFor(user.id, "REAUTH_SUCCEEDED");
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorUserId: user.id,
        metadata: { method: "password" },
      });
    });
  });

  describe("a user with MFA", () => {
    it("needs the code as well as the password", async () => {
      const { user, totpSecret, cookie } = await enrolledUser();
      const before = await prisma.twoFactor.findFirstOrThrow({
        where: { userId: user.id },
      });

      const noCode = await reauth(cookie, { password: STRONG });
      expect(noCode.status).toBe(400);
      expect(await noCode.json()).toMatchObject({
        code: "TWO_FACTOR_CODE_REQUIRED",
      });
      // Nothing was counted, so the missing code is no password oracle.
      expect(
        await prisma.accountLock.findUnique({ where: { userId: user.id } }),
      ).toBeNull();

      const wrongCode = await reauth(cookie, {
        password: STRONG,
        code: hotp(totpSecret, currentTotpStep(Date.now()) + 10),
      });
      expect(wrongCode.status).toBe(400);
      expect(await wrongCode.json()).toMatchObject({
        code: "INVALID_REAUTH_CREDENTIALS",
      });

      const wrongPassword = await reauth(cookie, {
        password: WRONG,
        code: nextCode(totpSecret),
      });
      expect(wrongPassword.status).toBe(400);
      expect(await wrongPassword.json()).toMatchObject({
        code: "INVALID_REAUTH_CREDENTIALS",
      });
      // A wrong password never claims the code.
      const after = await prisma.twoFactor.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(after.lastTotpStep).toBe(before.lastTotpStep);

      const ok = await reauth(cookie, {
        password: STRONG,
        code: nextCode(totpSecret),
      });
      expect(ok.status).toBe(200);
      expect(await eventsFor(user.id, "REAUTH_SUCCEEDED")).toMatchObject([
        { metadata: { method: "password_totp" } },
      ]);
    });

    it("rejects a code used twice at re-auth", async () => {
      const { totpSecret, cookie } = await enrolledUser();
      const code = nextCode(totpSecret);
      expect((await reauth(cookie, { password: STRONG, code })).status).toBe(
        200,
      );
      expect((await reauth(cookie, { password: STRONG, code })).status).toBe(
        400,
      );
    });

    it("rejects a code that signed the user in during the same step", async () => {
      const { email, totpSecret } = await enrolledUser();
      const code = nextCode(totpSecret);
      const cookie = await signInWithTotp(email, code);
      const response = await reauth(cookie, { password: STRONG, code });
      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "INVALID_REAUTH_CREDENTIALS",
      });
    });

    it("accepts a backup code once", async () => {
      const { user, backupCodes, cookie } = await enrolledUser();
      const [code] = backupCodes;
      const before = await prisma.twoFactor.findFirstOrThrow({
        where: { userId: user.id },
      });

      const ok = await reauth(cookie, { password: STRONG, code });
      expect(ok.status).toBe(200);
      expect(await eventsFor(user.id, "MFA_BACKUP_USED")).toHaveLength(1);
      expect(await eventsFor(user.id, "REAUTH_SUCCEEDED")).toMatchObject([
        { metadata: { method: "password_backup_code" } },
      ]);
      const after = await prisma.twoFactor.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(JSON.parse(after.backupCodes)).toHaveLength(
        JSON.parse(before.backupCodes).length - 1,
      );

      const again = await reauth(cookie, { password: STRONG, code });
      expect(again.status).toBe(400);
    });
  });

  describe("lockout", () => {
    it("counts failures, refuses while locked, and exempts a known device", async () => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);
      const unfamiliar = withoutDevice(cookie);
      lockout.mailer.clear();

      for (let i = 0; i < 5; i++) {
        const response = await reauth(unfamiliar, { password: WRONG });
        expect(response.status).toBe(400);
      }
      const lock = await prisma.accountLock.findUniqueOrThrow({
        where: { userId: user.id },
      });
      expect(lock.lockedUntil).not.toBeNull();
      expect(
        lockout.mailer.to(email).map((message) => message.template),
      ).toEqual(expect.arrayContaining(["account-locked", "account-unlock"]));
      expect(await eventsFor(user.id, "ACCOUNT_LOCKED")).toHaveLength(1);
      expect(await eventsFor(user.id, "REAUTH_FAILED")).toHaveLength(5);

      const locked = await reauth(unfamiliar, { password: STRONG });
      expect(locked.status).toBe(403);
      expect(await locked.json()).toMatchObject({ code: "REAUTH_LOCKED" });
      const refusals = (await eventsFor(user.id, "REAUTH_FAILED")).filter(
        (event) =>
          (event.metadata as { reason?: string } | null)?.reason ===
          "ACCOUNT_LOCKED",
      );
      expect(refusals).toHaveLength(1);

      // The device that completed a login is exempt from the account lock.
      const known = await reauth(cookie, { password: STRONG });
      expect(known.status).toBe(200);
    });

    it("resets the failure counter on success", async () => {
      const { email, user } = await verifiedUser();
      const cookie = withoutDevice(await signIn(email));
      await reauth(cookie, { password: WRONG });
      await reauth(cookie, { password: WRONG });
      expect(
        (
          await prisma.accountLock.findUniqueOrThrow({
            where: { userId: user.id },
          })
        ).failedCount,
      ).toBe(2);

      expect((await reauth(cookie, { password: STRONG })).status).toBe(200);
      expect(
        (
          await prisma.accountLock.findUniqueOrThrow({
            where: { userId: user.id },
          })
        ).failedCount,
      ).toBe(0);
    });
  });

  describe("the gated Better Auth endpoints", () => {
    it("lists only live endpoint paths", () => {
      const live = Object.values(auth.api).map(
        (endpoint) => (endpoint as { path?: string }).path,
      );
      for (const path of FRESH_AUTH_AUTH_PATHS) expect(live).toContain(path);
    });

    it("answers 403 REAUTH_REQUIRED for a stale session", async () => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);

      const change = await post(
        "/change-password",
        { currentPassword: STRONG, newPassword: "a-brand-new-password-9" },
        cookie,
      );
      expect(change.status).toBe(403);
      expect(await change.json()).toMatchObject({ code: "REAUTH_REQUIRED" });

      await stampSessions(user.id);
      const enable = await post(
        "/two-factor/enable",
        { password: STRONG },
        cookie,
      );
      expect(enable.status).toBe(200);
      await backdate((await latestSession(user.id)).id, 11 * MINUTE_MS);
      const uri = await post(
        "/two-factor/get-totp-uri",
        { password: STRONG },
        cookie,
      );
      expect(uri.status).toBe(403);
      expect(await uri.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
    });

    it("lets an admin's MFA refusal answer before the re-auth prompt", async () => {
      const { user, cookie } = await enrolledUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { isAdmin: true },
      });
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { lastReauthAt: null },
      });

      const disable = await post(
        "/two-factor/disable",
        { password: STRONG },
        cookie,
      );
      expect(disable.status).toBe(403);
      expect(await disable.json()).toMatchObject({
        code: "MFA_REQUIRED_FOR_ADMIN",
      });
    });

    it("gates a server-side call that carries a session, and no other", async () => {
      const { email } = await verifiedUser();
      const cookie = await signIn(email);
      await expect(
        auth.api.revokeOtherSessions({ headers: new Headers({ cookie }) }),
      ).rejects.toMatchObject({ body: { code: "REAUTH_REQUIRED" } });
      // No session: the endpoint's own 401 answers, not the gate.
      await expect(
        auth.api.revokeOtherSessions({ headers: new Headers() }),
      ).rejects.toMatchObject({ statusCode: 401 });
    });
  });

  describe("verify-password", () => {
    it("is gone over HTTP and still works in-process", async () => {
      const { email } = await verifiedUser();
      const cookie = await signIn(email);

      const http = await post("/verify-password", { password: STRONG }, cookie);
      expect(http.status).toBe(404);

      const inProcess = await auth.api.verifyPassword({
        headers: new Headers({ cookie }),
        body: { password: STRONG },
      });
      expect(inProcess).toEqual({ status: true });
    });
  });

  describe("a session deleted mid-request", () => {
    it("answers 401 and writes no REAUTH_SUCCEEDED", async () => {
      const { email, user } = await verifiedUser();
      const cookie = await signIn(email);
      const session = await latestSession(user.id);
      // The row goes just before the stamp's transaction opens, as when the
      // session is revoked between loading it and stamping it.
      const transaction = prisma.$transaction.bind(prisma) as (
        ...args: unknown[]
      ) => Promise<unknown>;
      vi.spyOn(prisma, "$transaction").mockImplementationOnce((async (
        ...args: unknown[]
      ) => {
        await prisma.session.deleteMany({ where: { id: session.id } });
        return transaction(...args);
      }) as unknown as typeof prisma.$transaction);

      const response = await reauth(cookie, { password: STRONG });
      expect(response.status).toBe(401);
      expect(await eventsFor(user.id, "REAUTH_SUCCEEDED")).toHaveLength(0);
    });
  });
});
