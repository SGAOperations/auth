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

describe.skipIf(!url)("audit events from Better Auth", () => {
  // Own client and auth instance: @/lib/prisma reads DATABASE_URL. The
  // options are the real ones, so the real hooks run.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const auth = betterAuth(
    buildAuthOptions({ prisma, baseURL: BASE_URL, secret: SECRET }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  const startedAt = new Date();
  let counter = 0;
  const freshEmail = () => `t73-${counter++}-${rand}@northeastern.edu`;

  // Audit rows cannot be deleted, so there is no cleanup for them: every
  // assertion filters by this run's users, ip or start time.
  afterAll(async () => {
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function post(
    path: string,
    body: unknown,
    headers: Record<string, string> = {},
  ) {
    return auth.handler(
      new Request(`${BASE_URL}/api/auth${path}`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin: BASE_URL,
          ...headers,
        },
        body: JSON.stringify(body),
      }),
    );
  }

  async function signUp(email: string) {
    await auth.api.signUpEmail({
      body: { email, password: STRONG, name: "Test User" },
    });
    return userByEmail(email);
  }

  async function verify(email: string) {
    const token = await createEmailVerificationToken(SECRET, email);
    await auth.api.verifyEmail({ query: { token } });
  }

  async function verifiedUser() {
    const email = freshEmail();
    const user = await signUp(email);
    await verify(email);
    return { email, user };
  }

  function userByEmail(email: string) {
    return prisma.user.findUniqueOrThrow({ where: { email } });
  }

  function eventsFor(userId: string, type: string) {
    return prisma.auditEvent.findMany({
      where: {
        type,
        OR: [{ targetId: userId }, { actorUserId: userId }],
      },
      orderBy: { createdAt: "asc" },
    });
  }

  async function signInWithCookie(email: string, headers = {}) {
    const response = await post(
      "/sign-in/email",
      { email, password: STRONG },
      headers,
    );
    expect(response.status).toBe(200);
    return response.headers
      .getSetCookie()
      .map((entry) => entry.split(";")[0])
      .join("; ");
  }

  it("records one USER_CREATED per sign-up and none for a repeat", async () => {
    const email = freshEmail();
    const user = await signUp(email);
    await auth.api.signUpEmail({
      body: { email, password: "other-password-B2!!", name: "Again" },
    });

    const events = await eventsFor(user.id, "USER_CREATED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "USER",
      actorUserId: user.id,
      targetType: "USER",
      metadata: { source: "self_signup" },
    });
  });

  it("records EMAIL_VERIFIED", async () => {
    const { user } = await verifiedUser();
    expect(await eventsFor(user.id, "EMAIL_VERIFIED")).toHaveLength(1);
  });

  it("records LOGIN_SUCCESS with the request's ip and user agent", async () => {
    const { email, user } = await verifiedUser();
    await signInWithCookie(email, {
      "x-forwarded-for": "203.0.113.9",
      "user-agent": "t73-agent",
    });

    const events = await eventsFor(user.id, "LOGIN_SUCCESS");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: user.id,
      metadata: { method: "password" },
      ip: "203.0.113.9",
      userAgent: "t73-agent",
    });
  });

  it("records LOGIN_FAILED for a wrong password, targeting the user", async () => {
    const { email, user } = await verifiedUser();
    const response = await post("/sign-in/email", {
      email,
      password: "not-the-right-password",
    });
    expect(response.status).toBe(401);

    const events = await eventsFor(user.id, "LOGIN_FAILED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "SYSTEM",
      metadata: { reason: "INVALID_EMAIL_OR_PASSWORD" },
    });
  });

  it("records LOGIN_FAILED for an unknown email with no target", async () => {
    const ip = `198.51.100.${Math.floor(Math.random() * 250) + 1}`;
    await post(
      "/sign-in/email",
      { email: freshEmail(), password: STRONG },
      { "x-forwarded-for": ip },
    );

    const events = await prisma.auditEvent.findMany({
      where: { type: "LOGIN_FAILED", ip, createdAt: { gte: startedAt } },
    });
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      targetType: null,
      targetId: null,
      metadata: { reason: "INVALID_EMAIL_OR_PASSWORD" },
    });
  });

  it("records the reason for an unverified and a deactivated user", async () => {
    const unverifiedEmail = freshEmail();
    const unverified = await signUp(unverifiedEmail);
    await post("/sign-in/email", { email: unverifiedEmail, password: STRONG });
    expect((await eventsFor(unverified.id, "LOGIN_FAILED"))[0]).toMatchObject({
      metadata: { reason: "EMAIL_NOT_VERIFIED" },
    });

    const { email, user } = await verifiedUser();
    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DEACTIVATED" },
    });
    await post("/sign-in/email", { email, password: STRONG });
    expect((await eventsFor(user.id, "LOGIN_FAILED"))[0]).toMatchObject({
      metadata: { reason: "ACCOUNT_DEACTIVATED" },
    });
  });

  it("records LOGOUT targeting the deleted session", async () => {
    const { email, user } = await verifiedUser();
    const cookie = await signInWithCookie(email);
    const session = await prisma.session.findFirstOrThrow({
      where: { userId: user.id },
    });

    const response = await post("/sign-out", {}, { cookie });
    expect(response.status).toBe(200);

    const events = await eventsFor(user.id, "LOGOUT");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: user.id,
      targetType: "SESSION",
      targetId: session.id,
    });
  });

  it("records SESSION_REVOKED targeting the revoked session", async () => {
    const { email, user } = await verifiedUser();
    await signInWithCookie(email);
    const cookie = await signInWithCookie(email);
    const sessions = await prisma.session.findMany({
      where: { userId: user.id },
      orderBy: { createdAt: "asc" },
    });
    const revoked = sessions[0];

    const response = await post(
      "/revoke-session",
      { token: revoked.token },
      { cookie },
    );
    expect(response.status).toBe(200);

    const events = await eventsFor(user.id, "SESSION_REVOKED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorUserId: user.id,
      targetType: "SESSION",
      targetId: revoked.id,
    });
  });

  it("records SESSIONS_REVOKED when other sessions are revoked", async () => {
    const { email, user } = await verifiedUser();
    await signInWithCookie(email);
    const cookie = await signInWithCookie(email);

    const response = await post("/revoke-other-sessions", {}, { cookie });
    expect(response.status).toBe(200);

    const events = await eventsFor(user.id, "SESSIONS_REVOKED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ metadata: { scope: "others" } });
  });

  it("records PASSWORD_CHANGED", async () => {
    const { email, user } = await verifiedUser();
    const cookie = await signInWithCookie(email);

    const response = await post(
      "/change-password",
      {
        currentPassword: STRONG,
        newPassword: "a-brand-new-password-9",
        revokeOtherSessions: true,
      },
      { cookie },
    );
    expect(response.status).toBe(200);

    const events = await eventsFor(user.id, "PASSWORD_CHANGED");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      metadata: { revokedOtherSessions: true },
    });
  });
});
