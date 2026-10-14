import { afterAll, describe, expect, it } from "vitest";
import { betterAuth } from "better-auth";
import { createEmailVerificationToken } from "better-auth/api";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { buildAuthOptions } from "@/lib/auth/options";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const STRONG = "correct-horse-battery-staple";

describe.skipIf(!url)("email and password sign-in", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL, and
  // config.ts parses the app environment. The options are the real ones.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth(
    buildAuthOptions({ prisma, baseURL: BASE_URL, secret: SECRET }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;
  const freshEmail = (domain = "northeastern.edu") =>
    `t17-${counter++}-${rand}@${domain}`;

  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  function signUp(email: string, password: string, name = "Test User") {
    return auth.api.signUpEmail({ body: { email, password, name } });
  }

  function signIn(email: string, password: string) {
    return auth.api.signInEmail({ body: { email, password } });
  }

  async function verify(email: string) {
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
  }

  async function expectApiError(
    promise: Promise<unknown>,
    statusCode: number,
    code: string,
  ) {
    const error = await promise.then(
      () => null,
      (e: unknown) => e,
    );
    expect(error).toMatchObject({ statusCode, body: { code } });
  }

  async function userByEmail(email: string) {
    return prisma.user.findUniqueOrThrow({
      where: { email: email.trim().toLowerCase() },
    });
  }

  async function credentialHash(userId: string) {
    const account = await prisma.account.findFirstOrThrow({
      where: { userId, providerId: "credential" },
    });
    return account.password;
  }

  async function addSession(userId: string) {
    return prisma.session.create({
      data: {
        token: `t17-${rand}-${counter++}`,
        userId,
        expiresAt: new Date(Date.now() + 60_000),
      },
    });
  }

  it.each([
    "x@gmail.com",
    "x@husky.neu.edu",
    "x@sub.northeastern.edu",
    "x@northeastern.edu.evil.com",
  ])("rejects sign-up with %s", async (address) => {
    const email = `t17-${counter++}-${rand}-${address}`;
    await expectApiError(
      signUp(email, STRONG),
      400,
      "EMAIL_DOMAIN_NOT_ALLOWED",
    );
    expect(await prisma.user.count({ where: { email } })).toBe(0);
  });

  it("answers an existing non-northeastern user the same way as an unknown one", async () => {
    const email = freshEmail("gmail.com");
    await prisma.user.create({ data: { email, name: "Admin Created" } });
    await expectApiError(
      signUp(email, STRONG),
      400,
      "EMAIL_DOMAIN_NOT_ALLOWED",
    );
  });

  it("signs up a normalized northeastern.edu user without a session", async () => {
    const local = `X-${counter++}-${rand}`;
    const result = await signUp(`  ${local}@Northeastern.EDU `, STRONG);
    expect(result.token).toBeNull();

    const user = await userByEmail(`${local}@northeastern.edu`);
    expect(user.email).toBe(`${local.toLowerCase()}@northeastern.edu`);
    expect(user.emailVerified).toBe(false);
    expect(user.isAdmin).toBe(false);
    expect(user.isPrimaryAdmin).toBe(false);
    expect(user.status).toBe("ACTIVE");
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
  });

  it("requires verification, then signs in with a padded mixed-case email", async () => {
    const email = freshEmail();
    await signUp(email, STRONG);
    await expectApiError(signIn(email, STRONG), 403, "EMAIL_NOT_VERIFIED");

    await verify(email);
    const padded = `  ${email.toUpperCase()} `;
    const result = await signIn(padded, STRONG);
    expect(result.user.email).toBe(email);

    const user = await userByEmail(email);
    expect(user.lastLoginAt).not.toBeNull();
  });

  it("rejects passwords outside 12 to 128 characters", async () => {
    const short = freshEmail();
    await expectApiError(
      signUp(short, "a".repeat(11)),
      400,
      "PASSWORD_TOO_SHORT",
    );
    const long = freshEmail();
    await expectApiError(
      signUp(long, "a".repeat(129)),
      400,
      "PASSWORD_TOO_LONG",
    );
    expect(await prisma.user.count({ where: { email: short } })).toBe(0);
    expect(await prisma.user.count({ where: { email: long } })).toBe(0);
  });

  it("does not overwrite an unverified account with an invalid password", async () => {
    const email = freshEmail();
    await signUp(email, STRONG, "Original");
    const user = await userByEmail(email);
    const before = await credentialHash(user.id);

    await expectApiError(
      signUp(email, "short", "Attacker"),
      400,
      "PASSWORD_TOO_SHORT",
    );
    expect(await credentialHash(user.id)).toBe(before);
    expect((await userByEmail(email)).name).toBe("Original");
  });

  it("gives a wrong password and an unknown email the same error", async () => {
    const email = freshEmail();
    await signUp(email, STRONG);
    await verify(email);
    await expectApiError(
      signIn(email, "not-the-right-password"),
      401,
      "INVALID_EMAIL_OR_PASSWORD",
    );
    await expectApiError(
      signIn(freshEmail(), STRONG),
      401,
      "INVALID_EMAIL_OR_PASSWORD",
    );
  });

  it("refuses a deactivated user at get-session and at sign-in", async () => {
    const email = freshEmail();
    await signUp(email, STRONG);
    await verify(email);

    const { headers } = await auth.api.signInEmail({
      body: { email, password: STRONG },
      returnHeaders: true,
    });
    const cookie = headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
    const getSession = () =>
      auth.handler(
        new Request(`${BASE_URL}/api/auth/get-session`, {
          headers: { cookie },
        }),
      );

    const user = await userByEmail(email);
    expect((await getSession()).status).toBe(200);

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DEACTIVATED" },
    });
    const response = await getSession();
    expect(response.status).toBe(401);
    expect(await response.json()).toMatchObject({
      code: "ACCOUNT_DEACTIVATED",
    });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    await expectApiError(signIn(email, STRONG), 403, "ACCOUNT_DEACTIVATED");
    await expectApiError(
      signIn(email, "not-the-right-password"),
      401,
      "INVALID_EMAIL_OR_PASSWORD",
    );
  });

  it("lets only the address owner who verifies keep the account", async () => {
    const email = freshEmail();
    const passwordA = "attacker-password-A1";
    const passwordB = "victim-password-B2!";

    const fresh = await signUp(email, passwordA, "Attacker");
    const user = await userByEmail(email);
    await addSession(user.id);

    const takeover = await signUp(email, passwordB, "Victim");
    expect(takeover.token).toBeNull();
    expect(Object.keys(takeover).sort()).toEqual(Object.keys(fresh).sort());
    expect(Object.keys(takeover.user).sort()).toEqual(
      Object.keys(fresh.user).sort(),
    );

    // A session opened after the overwrite is also revoked by verification.
    const lateSession = await addSession(user.id);
    await verify(email);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.session.findUnique({ where: { id: lateSession.id } }),
    ).toBeNull();

    await expectApiError(
      signIn(email, passwordA),
      401,
      "INVALID_EMAIL_OR_PASSWORD",
    );
    expect((await signIn(email, passwordB)).user.id).toBe(user.id);

    // The account is verified now: a further sign-up changes nothing.
    await signUp(email, "third-password-C3!!", "Third");
    expect((await userByEmail(email)).name).toBe("Victim");
    await expectApiError(
      signIn(email, "third-password-C3!!"),
      401,
      "INVALID_EMAIL_OR_PASSWORD",
    );
    expect((await signIn(email, passwordB)).user.id).toBe(user.id);
  });
});
