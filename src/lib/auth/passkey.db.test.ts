import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { createAdminGuard } from "@/lib/auth/admin-guard";
import { buildAuthOptions } from "@/lib/auth/options";
import { MAX_PASSKEYS_PER_USER } from "@/lib/auth/passkey-policy";
import { buildAuthPlugins } from "@/lib/auth/plugins";
import { testLockout } from "@/test/lockout-options";
import {
  createSoftwareAuthenticator,
  type SoftwareCredential,
} from "@/test/webauthn-authenticator";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";
const MINUTE_MS = 60 * 1000;

describe.skipIf(!url)("passkeys", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL. The options
  // and plugins are the real ones, so the real hooks run. The relying party is
  // `localhost`, which is what the origin of BASE_URL resolves to.
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
      passkey: { rpID: "localhost", rpName: "Test", origin: BASE_URL },
      prisma,
      issuer: BASE_URL,
      secret: SECRET,
      sgauthEnv: "local",
      mailer: lockout.mailer,
    }),
  });
  const adminGuard = createAdminGuard({
    getSession: (headers) => auth.api.getSession({ headers }),
    prisma,
  });
  const authenticator = createSoftwareAuthenticator();

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = () => `t105-${counter++}-${rand}@northeastern.edu`;

  // Audit rows cannot be deleted, so every assertion filters by this run's
  // users. Their sessions and passkeys go with them.
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

  const headersOf = (cookie: string, extra: Record<string, string> = {}) => ({
    origin: BASE_URL,
    ...(cookie ? { cookie } : {}),
    ...extra,
  });

  function get(path: string, cookie = "") {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "GET",
        headers: headersOf(cookie),
      }),
    );
  }

  function post(path: string, body: unknown, cookie = "") {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: headersOf(cookie, { "content-type": "application/json" }),
        body: JSON.stringify(body),
      }),
    );
  }

  async function verifiedUser() {
    const email = freshEmail();
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Passkey Test" },
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

  // Sets the stamp as if the re-auth happened `ageMs` ago.
  const stampSessions = (userId: string, ageMs = 0) =>
    prisma.session.updateMany({
      where: { userId },
      data: { lastReauthAt: new Date(Date.now() - ageMs) },
    });

  function eventsFor(userId: string, type: string) {
    return prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
      orderBy: { createdAt: "asc" },
    });
  }

  /** A signed-in user whose sessions have just re-authenticated. */
  async function freshUser() {
    const { email, user } = await verifiedUser();
    const cookie = await signIn(email);
    await stampSessions(user.id);
    return { email, user, cookie };
  }

  /** Runs the registration ceremony. Returns the response and the credential. */
  async function enroll(
    cookie: string,
    { name, uv = true }: { name?: string; uv?: boolean } = {},
  ) {
    const options = await get(
      `/passkey/generate-register-options${name ? `?name=${encodeURIComponent(name)}` : ""}`,
      cookie,
    );
    expect(options.status).toBe(200);
    const challengeCookie = mergeCookies(cookie, options);
    const { credential, response } = authenticator.register(
      await options.json(),
      { origin: BASE_URL, uv },
    );
    const verified = await post(
      "/passkey/verify-registration",
      { response, ...(name ? { name } : {}) },
      challengeCookie,
    );
    return { verified, credential };
  }

  /** Runs the sign-in ceremony from a browser with no session. */
  async function signInWithPasskey(
    credential: SoftwareCredential,
    { uv = true, badSignature = false } = {},
  ) {
    const options = await get("/passkey/generate-authenticate-options");
    expect(options.status).toBe(200);
    const challengeCookie = mergeCookies("", options);
    const response = authenticator.authenticate(await options.json(), {
      origin: BASE_URL,
      uv,
      credential,
      badSignature,
    });
    const verified = await post(
      "/passkey/verify-authentication",
      { response },
      challengeCookie,
    );
    return { verified, cookie: mergeCookies(challengeCookie, verified) };
  }

  async function passkeyRowsOf(userId: string) {
    return prisma.passkey.findMany({ where: { userId } });
  }

  describe("enrollment", () => {
    it("answers 403 REAUTH_REQUIRED to a stale session, and enrolls once fresh", async () => {
      const { user, cookie } = await freshUser();

      const expectRefused = async () => {
        const stale = await get("/passkey/generate-register-options", cookie);
        expect(stale.status).toBe(403);
        expect(await stale.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      };

      // Never re-authenticated, then re-authenticated 11 minutes ago.
      await prisma.session.updateMany({
        where: { userId: user.id },
        data: { lastReauthAt: null },
      });
      await expectRefused();
      await stampSessions(user.id, 11 * MINUTE_MS);
      await expectRefused();

      await stampSessions(user.id);
      const { verified } = await enroll(cookie, { name: "  MacBook  " });
      expect(verified.status).toBe(200);
      const body: { id: string } = await verified.json();

      const rows = await passkeyRowsOf(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({ id: body.id, name: "MacBook" });
      const added = await eventsFor(user.id, "PASSKEY_ADDED");
      expect(added).toHaveLength(1);
      expect(added[0]?.metadata).toEqual({ passkeyId: body.id });
    });

    it("refuses the finishing step without a fresh re-auth too", async () => {
      const { user, cookie } = await freshUser();
      const options = await get("/passkey/generate-register-options", cookie);
      const challengeCookie = mergeCookies(cookie, options);
      const { response } = authenticator.register(await options.json(), {
        origin: BASE_URL,
        uv: true,
      });
      await stampSessions(user.id, 11 * MINUTE_MS);

      const verified = await post(
        "/passkey/verify-registration",
        { response },
        challengeCookie,
      );
      expect(verified.status).toBe(403);
      expect(await verified.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      expect(await passkeyRowsOf(user.id)).toHaveLength(0);
    });

    it("refuses a name over 64 characters", async () => {
      const { user, cookie } = await freshUser();
      const { verified } = await enroll(cookie, { name: "a".repeat(65) });
      expect(verified.status).toBe(400);
      expect(await verified.json()).toMatchObject({
        code: "INVALID_PASSKEY_NAME",
      });
      expect(await passkeyRowsOf(user.id)).toHaveLength(0);
    });

    it("stops at the cap with 400 PASSKEY_LIMIT_REACHED", async () => {
      const { user, cookie } = await freshUser();
      await prisma.passkey.createMany({
        data: Array.from({ length: MAX_PASSKEYS_PER_USER }, (_, index) => ({
          userId: user.id,
          credentialID: `cap-${rand}-${user.id}-${index}`,
          publicKey: "unused",
          counter: 0,
          deviceType: "singleDevice",
          backedUp: false,
        })),
      });

      const options = await get("/passkey/generate-register-options", cookie);
      expect(options.status).toBe(400);
      expect(await options.json()).toMatchObject({
        code: "PASSKEY_LIMIT_REACHED",
      });
    });
  });

  describe("sign-in", () => {
    it("signs in with a passkey, and records the method and lastLoginAt", async () => {
      const { user, cookie } = await freshUser();
      const { credential } = await enroll(cookie);
      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: null },
      });

      const { verified, cookie: passkeyCookie } =
        await signInWithPasskey(credential);
      expect(verified.status).toBe(200);
      expect(verified.headers.getSetCookie().join(";")).toContain(
        "session_token",
      );
      const session = await get("/get-session", passkeyCookie);
      expect(await session.json()).toMatchObject({ user: { id: user.id } });

      const logins = await eventsFor(user.id, "LOGIN_SUCCESS");
      expect(logins.at(-1)?.metadata).toEqual({ method: "passkey" });
      const row = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(row.lastLoginAt).not.toBeNull();
    });

    it("yields a session shaped exactly like a password session", async () => {
      const { email, user, cookie } = await freshUser();
      const { credential } = await enroll(cookie);

      const passwordCookie = await signIn(email);
      const { cookie: passkeyCookie } = await signInWithPasskey(credential);

      const [password, passkey] = await Promise.all(
        [passwordCookie, passkeyCookie].map(async (value) => {
          const response = await get("/get-session", value);
          expect(response.status).toBe(200);
          return (await response.json()) as {
            session: Record<string, unknown>;
            user: Record<string, unknown>;
          };
        }),
      );
      expect(Object.keys(passkey).sort()).toEqual(Object.keys(password).sort());
      expect(Object.keys(passkey.session).sort()).toEqual(
        Object.keys(password.session).sort(),
      );
      expect(passkey.user).toEqual(password.user);

      const sessions = await prisma.session.findMany({
        where: { userId: user.id },
      });
      expect(sessions.length).toBeGreaterThanOrEqual(3);
      for (const row of sessions) {
        expect(row.absoluteExpiresAt).toBeInstanceOf(Date);
        expect(row.expiresAt.getTime()).toBeLessThanOrEqual(
          row.absoluteExpiresAt.getTime(),
        );
      }
    });

    it("refuses an assertion without user verification", async () => {
      const { user, cookie } = await freshUser();
      const { credential } = await enroll(cookie);
      const before = await prisma.session.count({ where: { userId: user.id } });

      const { verified } = await signInWithPasskey(credential, { uv: false });
      expect(verified.status).toBe(400);
      expect(await verified.json()).toMatchObject({
        code: "PASSKEY_USER_VERIFICATION_REQUIRED",
      });
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
        before,
      );
    });

    it("leaves the lockout alone when the signature is bad", async () => {
      const { user, cookie } = await freshUser();
      const { credential } = await enroll(cookie);

      const { verified } = await signInWithPasskey(credential, {
        badSignature: true,
      });
      expect(verified.status).toBeGreaterThanOrEqual(400);
      expect(verified.status).toBeLessThan(500);
      expect(
        await prisma.accountLock.findUnique({ where: { userId: user.id } }),
      ).toBeNull();
    });

    it("lets an admin without TOTP in, and the admin guard still refuses them", async () => {
      const { user, cookie } = await freshUser();
      const { credential } = await enroll(cookie);
      await prisma.user.update({
        where: { id: user.id },
        data: { isAdmin: true },
      });

      const { verified, cookie: passkeyCookie } =
        await signInWithPasskey(credential);
      expect(verified.status).toBe(200);

      const guarded = await adminGuard.requireAdmin(
        new Headers({ cookie: passkeyCookie }),
      );
      expect(guarded.ok).toBe(false);
      if (guarded.ok) return;
      expect(guarded.response.status).toBe(403);
      expect(await guarded.response.json()).toMatchObject({
        code: "MFA_REQUIRED",
      });
    });
  });

  describe("removal", () => {
    it("needs a fresh re-auth, writes PASSKEY_REMOVED, and kills the credential", async () => {
      const { user, cookie } = await freshUser();
      const { verified, credential } = await enroll(cookie);
      const { id }: { id: string } = await verified.json();

      await stampSessions(user.id, 11 * MINUTE_MS);
      const stale = await post("/passkey/delete-passkey", { id }, cookie);
      expect(stale.status).toBe(403);
      expect(await stale.json()).toMatchObject({ code: "REAUTH_REQUIRED" });
      expect(await passkeyRowsOf(user.id)).toHaveLength(1);

      await stampSessions(user.id);
      const removed = await post("/passkey/delete-passkey", { id }, cookie);
      expect(removed.status).toBe(200);
      expect(await passkeyRowsOf(user.id)).toHaveLength(0);
      const events = await eventsFor(user.id, "PASSKEY_REMOVED");
      expect(events).toHaveLength(1);
      expect(events[0]?.metadata).toEqual({ passkeyId: id });

      const attempt = await signInWithPasskey(credential);
      expect(attempt.verified.status).toBeGreaterThanOrEqual(400);
    });

    it("cannot remove another user's passkey", async () => {
      const owner = await freshUser();
      const { verified } = await enroll(owner.cookie);
      const { id }: { id: string } = await verified.json();

      const other = await freshUser();
      const response = await post(
        "/passkey/delete-passkey",
        { id },
        other.cookie,
      );
      expect(response.status).toBeGreaterThanOrEqual(400);
      expect(response.status).toBeLessThan(500);
      expect(await passkeyRowsOf(owner.user.id)).toHaveLength(1);
      expect(await eventsFor(other.user.id, "PASSKEY_REMOVED")).toHaveLength(0);
    });
  });

  describe("account status", () => {
    it.each(["DEACTIVATED", "DELETED"] as const)(
      "drops every passkey when the status becomes %s, and reactivation does not restore them",
      async (status) => {
        const { user, cookie } = await freshUser();
        const { credential } = await enroll(cookie);
        await prisma.passkey.create({
          data: {
            userId: user.id,
            credentialID: `second-${rand}-${user.id}`,
            publicKey: "unused",
            counter: 0,
            deviceType: "singleDevice",
            backedUp: false,
          },
        });
        expect(await passkeyRowsOf(user.id)).toHaveLength(2);

        await prisma.user.update({ where: { id: user.id }, data: { status } });
        expect(await passkeyRowsOf(user.id)).toHaveLength(0);

        const attempt = await signInWithPasskey(credential);
        expect(attempt.verified.status).toBeGreaterThanOrEqual(400);

        await prisma.user.update({
          where: { id: user.id },
          data: { status: "ACTIVE" },
        });
        expect(await passkeyRowsOf(user.id)).toHaveLength(0);
      },
    );

    const newPasskey = (userId: string, tag: string) => ({
      userId,
      credentialID: `${tag}-${rand}-${userId}`,
      publicKey: "unused",
      counter: 0,
      deviceType: "singleDevice",
      backedUp: false,
    });
    const pause = (ms: number) =>
      new Promise((resolve) => setTimeout(resolve, ms));

    it("refuses a passkey for a user who is not active", async () => {
      const { user } = await verifiedUser();
      await prisma.user.update({
        where: { id: user.id },
        data: { status: "DEACTIVATED" },
      });
      await expect(
        prisma.passkey.create({ data: newPasskey(user.id, "inactive") }),
      ).rejects.toThrow();
      expect(await passkeyRowsOf(user.id)).toHaveLength(0);
    });

    it("removes a passkey inserted while a deactivation is racing it", async () => {
      const { user } = await verifiedUser();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let inserted: () => void = () => {};
      const insertedP = new Promise<void>((resolve) => (inserted = resolve));

      // The insert has passed its status check and holds the User row.
      const insertTx = prisma.$transaction(async (tx) => {
        await tx.passkey.create({ data: newPasskey(user.id, "race-a") });
        inserted();
        await gate;
      });
      await insertedP;
      const deactivate = prisma.user.update({
        where: { id: user.id },
        data: { status: "DEACTIVATED" },
      });
      await pause(300);
      release();
      await insertTx;
      await deactivate;

      expect(await passkeyRowsOf(user.id)).toHaveLength(0);
    });

    it("refuses a passkey inserted after a deactivation that has not committed yet", async () => {
      const { user } = await verifiedUser();
      let release: () => void = () => {};
      const gate = new Promise<void>((resolve) => (release = resolve));
      let deactivated: () => void = () => {};
      const deactivatedP = new Promise<void>(
        (resolve) => (deactivated = resolve),
      );

      const deactivateTx = prisma.$transaction(async (tx) => {
        await tx.user.update({
          where: { id: user.id },
          data: { status: "DEACTIVATED" },
        });
        deactivated();
        await gate;
      });
      await deactivatedP;
      const insert = prisma.passkey
        .create({ data: newPasskey(user.id, "race-b") })
        .then(
          () => "inserted",
          () => "refused",
        );
      await pause(300);
      release();
      await deactivateTx;

      expect(await insert).toBe("refused");
      expect(await passkeyRowsOf(user.id)).toHaveLength(0);
    });

    it("leaves passkeys alone when the status does not change", async () => {
      const { user, cookie } = await freshUser();
      await enroll(cookie);
      await prisma.user.update({
        where: { id: user.id },
        data: { name: "Renamed" },
      });
      expect(await passkeyRowsOf(user.id)).toHaveLength(1);
    });
  });
});
