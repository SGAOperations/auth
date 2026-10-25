import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { symmetricDecrypt } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createAdminGuard } from "@/lib/auth/admin-guard";
import { buildAuthOptions } from "@/lib/auth/options";
import { testLockout } from "@/test/lockout-options";
import { buildAuthPlugins } from "@/lib/auth/plugins";
import { currentTotpStep, hotp } from "@/lib/auth/totp";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";

describe.skipIf(!url)("TOTP multi-factor authentication", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL. The options
  // and plugins are the real ones, so the real hooks run.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth({
    ...buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: testLockout(),
    }),
    plugins: buildAuthPlugins({
      signupAllowlist: null,
      prisma,
      issuer: BASE_URL,
      secret: SECRET,
      sgauthEnv: "local",
    }),
  });
  const guard = createAdminGuard({
    getSession: (headers) => auth.api.getSession({ headers }),
    prisma,
  });

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t67-${counter++}-${rand}@northeastern.edu`;

  // Audit rows cannot be deleted, so every assertion filters by this run's
  // users. A user's TwoFactor row goes with it.
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

  async function verifiedUser() {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
    return {
      email,
      user: await prisma.user.findUniqueOrThrow({ where: { email } }),
    };
  }

  function eventsFor(userId: string, type: string) {
    return prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
      orderBy: { createdAt: "asc" },
    });
  }

  async function loginMethods(userId: string) {
    const events = await eventsFor(userId, "LOGIN_SUCCESS");
    return events.map((event) => (event.metadata as { method: string }).method);
  }

  async function totpSecretOf(userId: string) {
    const row = await prisma.twoFactor.findFirstOrThrow({ where: { userId } });
    return symmetricDecrypt({
      key: (await auth.$context).secretConfig,
      data: row.secret,
    });
  }

  // The code one step after the current one. Enrollment accepts the current
  // step, so this is always newer than the last accepted step and still inside
  // the plugin's window.
  const nextCode = (totpSecret: string) =>
    hotp(totpSecret, currentTotpStep(Date.now()) + 1);

  async function signIn(email: string) {
    const response = await post("/sign-in/email", { email, password: STRONG });
    expect(response.status).toBe(200);
    return { response, cookie: mergeCookies("", response) };
  }

  async function enrolledUser() {
    const { email, user } = await verifiedUser();
    let { cookie } = await signIn(email);
    const enable = await post(
      "/two-factor/enable",
      { password: STRONG },
      cookie,
    );
    expect(enable.status).toBe(200);
    const enabled: { totpURI: string; backupCodes: string[] } =
      await enable.json();
    const totpSecret = await totpSecretOf(user.id);
    const verify = await post(
      "/two-factor/verify-totp",
      { code: hotp(totpSecret, currentTotpStep(Date.now())) },
      cookie,
    );
    expect(verify.status).toBe(200);
    cookie = mergeCookies(cookie, verify);
    return { email, user, totpSecret, enabled, cookie };
  }

  // Password step of an enrolled user's sign-in: returns the challenge cookie.
  async function startChallenge(email: string) {
    const { response, cookie } = await signIn(email);
    expect(await response.json()).toMatchObject({ twoFactorRedirect: true });
    return cookie;
  }

  async function signInWithBackupCode(email: string, code: string) {
    const challenge = await startChallenge(email);
    const response = await post(
      "/two-factor/verify-backup-code",
      { code },
      challenge,
    );
    expect(response.status).toBe(200);
    return mergeCookies(challenge, response);
  }

  describe("enrollment", () => {
    it("enables only after the first valid code, with hashed backup codes", async () => {
      const { email, user } = await verifiedUser();
      const { cookie } = await signIn(email);

      const wrong = await post(
        "/two-factor/enable",
        { password: "nope" },
        cookie,
      );
      expect(wrong.status).toBe(400);

      const enable = await post(
        "/two-factor/enable",
        { password: STRONG },
        cookie,
      );
      expect(enable.status).toBe(200);
      const body: { totpURI: string; backupCodes: string[] } =
        await enable.json();
      expect(new URL(body.totpURI).searchParams.get("issuer")).toBe(
        "SGAuth (local)",
      );
      expect(body.backupCodes).toHaveLength(10);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(false);

      const stored = await prisma.twoFactor.findFirstOrThrow({
        where: { userId: user.id },
      });
      const hashes: string[] = JSON.parse(stored.backupCodes);
      expect(hashes).toHaveLength(10);
      expect(hashes.every((entry) => entry.startsWith("h1:"))).toBe(true);
      for (const code of body.backupCodes) {
        expect(stored.backupCodes).not.toContain(code);
      }

      const verify = await post(
        "/two-factor/verify-totp",
        {
          code: hotp(await totpSecretOf(user.id), currentTotpStep(Date.now())),
        },
        cookie,
      );
      expect(verify.status).toBe(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(true);
      expect(await eventsFor(user.id, "MFA_ENROLLED")).toHaveLength(1);
      // Enrollment rotates the session; that is not a login.
      expect(await loginMethods(user.id)).toEqual(["password"]);
    });
  });

  describe("sign-in", () => {
    it("holds the session back until the second factor", async () => {
      const { email, user, totpSecret } = await enrolledUser();
      const before = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      const sessions = await prisma.session.count({
        where: { userId: user.id },
      });

      const challenge = await startChallenge(email);
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
        sessions,
      );
      expect(await loginMethods(user.id)).toEqual(["password"]);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .lastLoginAt,
      ).toEqual(before.lastLoginAt);

      const verify = await post(
        "/two-factor/verify-totp",
        { code: nextCode(totpSecret) },
        challenge,
      );
      expect(verify.status).toBe(200);
      expect(await loginMethods(user.id)).toEqual(["password", "totp"]);
    });

    it("leaves a user without MFA on the password path", async () => {
      const { email, user } = await verifiedUser();
      const { response } = await signIn(email);
      expect(await response.json()).not.toHaveProperty("twoFactorRedirect");
      expect(await loginMethods(user.id)).toEqual(["password"]);
    });

    it("rejects a replayed code, even in a later challenge", async () => {
      const { email, totpSecret } = await enrolledUser();
      const code = nextCode(totpSecret);

      const first = await post(
        "/two-factor/verify-totp",
        { code },
        await startChallenge(email),
      );
      expect(first.status).toBe(200);

      const replay = await post(
        "/two-factor/verify-totp",
        { code },
        await startChallenge(email),
      );
      expect(replay.status).toBe(401);
      expect(await replay.json()).toMatchObject({ code: "INVALID_CODE" });
    });

    it("accepts one of two concurrent requests with the same code", async () => {
      const { email, totpSecret } = await enrolledUser();
      const code = nextCode(totpSecret);
      const challenges = [
        await startChallenge(email),
        await startChallenge(email),
      ];

      const responses = await Promise.all(
        challenges.map((cookie) =>
          post("/two-factor/verify-totp", { code }, cookie),
        ),
      );
      expect(responses.map((r) => r.status).sort()).toEqual([200, 401]);
    });

    it("records LOGIN_FAILED for a wrong code, targeting the user", async () => {
      const { email, user } = await enrolledUser();
      const response = await post(
        "/two-factor/verify-totp",
        { code: "000000" },
        await startChallenge(email),
      );
      expect(response.status).toBe(401);

      const events = (await eventsFor(user.id, "LOGIN_FAILED")).filter(
        (event) =>
          (event.metadata as { reason: string }).reason ===
          "INVALID_TWO_FACTOR_CODE",
      );
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: "SYSTEM",
        targetType: "USER",
        targetId: user.id,
      });
    });

    it("never trusts the device", async () => {
      const { email, totpSecret } = await enrolledUser();
      const verify = await post(
        "/two-factor/verify-totp",
        { code: nextCode(totpSecret), trustDevice: true },
        await startChallenge(email),
      );
      expect(verify.status).toBe(200);
      const cookies = verify.headers.getSetCookie().join("\n");
      expect(cookies).not.toContain("trust_device");

      const next = await post("/sign-in/email", {
        email,
        password: STRONG,
      });
      expect(await next.json()).toMatchObject({ twoFactorRedirect: true });
    });
  });

  describe("backup codes", () => {
    it("accepts each code once and records its use", async () => {
      const { email, user, enabled } = await enrolledUser();
      const [first] = enabled.backupCodes;

      await signInWithBackupCode(email, first);
      expect(await eventsFor(user.id, "MFA_BACKUP_USED")).toHaveLength(1);
      expect(await loginMethods(user.id)).toEqual(["password", "backup_code"]);

      const reuse = await post(
        "/two-factor/verify-backup-code",
        { code: first },
        await startChallenge(email),
      );
      expect(reuse.status).toBe(401);
    });

    it("replaces every earlier code when regenerated", async () => {
      const { email, user, enabled } = await enrolledUser();
      const cookie = await signInWithBackupCode(email, enabled.backupCodes[0]);

      const regenerate = await post(
        "/two-factor/generate-backup-codes",
        { password: STRONG },
        cookie,
      );
      expect(regenerate.status).toBe(200);
      const fresh: { backupCodes: string[] } = await regenerate.json();
      expect(
        await eventsFor(user.id, "MFA_BACKUP_CODES_REGENERATED"),
      ).toHaveLength(1);

      const old = await post(
        "/two-factor/verify-backup-code",
        { code: enabled.backupCodes[1] },
        await startChallenge(email),
      );
      expect(old.status).toBe(401);
      await signInWithBackupCode(email, fresh.backupCodes[0]);
    });
  });

  describe("disabling", () => {
    it("requires the password and is allowed for a non-admin", async () => {
      const { email, user, enabled } = await enrolledUser();
      const cookie = await signInWithBackupCode(email, enabled.backupCodes[0]);

      const wrong = await post(
        "/two-factor/disable",
        { password: "nope" },
        cookie,
      );
      expect(wrong.status).toBe(400);

      const disable = await post(
        "/two-factor/disable",
        { password: STRONG },
        cookie,
      );
      expect(disable.status).toBe(200);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(false);
      expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(
        0,
      );
      expect(await eventsFor(user.id, "MFA_DISABLED")).toHaveLength(1);
    });

    it("is refused for an admin", async () => {
      const { email, user, enabled } = await enrolledUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { isAdmin: true },
      });
      const cookie = await signInWithBackupCode(email, enabled.backupCodes[0]);

      const disable = await post(
        "/two-factor/disable",
        { password: STRONG },
        cookie,
      );
      expect(disable.status).toBe(403);
      expect(await disable.json()).toMatchObject({
        code: "MFA_REQUIRED_FOR_ADMIN",
      });
      expect(await prisma.twoFactor.count({ where: { userId: user.id } })).toBe(
        1,
      );
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .twoFactorEnabled,
      ).toBe(true);
      expect(await eventsFor(user.id, "MFA_DISABLED")).toHaveLength(0);
    });
  });

  describe("admin guard", () => {
    it("locks an admin out until they enroll", async () => {
      const { email, user } = await verifiedUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { isAdmin: true },
      });
      let { cookie } = await signIn(email);

      const locked = await guard.requireAdmin(new Headers({ cookie }));
      expect(locked.ok).toBe(false);
      if (locked.ok) return;
      expect(locked.response.status).toBe(403);
      expect(await locked.response.json()).toMatchObject({
        code: "MFA_REQUIRED",
        enrollmentUrl: "/account/security",
      });

      const enable = await post(
        "/two-factor/enable",
        { password: STRONG },
        cookie,
      );
      expect(enable.status).toBe(200);
      const verify = await post(
        "/two-factor/verify-totp",
        {
          code: hotp(await totpSecretOf(user.id), currentTotpStep(Date.now())),
        },
        cookie,
      );
      expect(verify.status).toBe(200);
      cookie = mergeCookies(cookie, verify);

      const allowed = await guard.requireAdmin(new Headers({ cookie }));
      expect(allowed).toEqual({ ok: true, actor: { id: user.id } });
    });

    it("answers 403 NOT_ADMIN for a non-admin and 401 with no session", async () => {
      const { email } = await verifiedUser();
      const { cookie } = await signIn(email);

      const notAdmin = await guard.requireAdmin(new Headers({ cookie }));
      expect(notAdmin.ok).toBe(false);
      if (!notAdmin.ok) {
        expect(notAdmin.response.status).toBe(403);
        expect(await notAdmin.response.json()).toMatchObject({
          code: "NOT_ADMIN",
        });
      }

      const anonymous = await guard.requireAdmin(new Headers());
      expect(anonymous.ok).toBe(false);
      if (!anonymous.ok) expect(anonymous.response.status).toBe(401);
    });
  });
});
