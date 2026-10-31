import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  STRONG,
  WRONG,
  auditEvents,
  auditEventsByIp,
  auditTypes,
  createAuthHttpApp,
  ipFor,
} from "@/test/auth-http";
import { createUser } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 10);
let counter = 0;
const freshLocal = () => `flow-su-${counter++}-${rand}`;

describe("sign-up and sign-in flows over HTTP", () => {
  const app = createAuthHttpApp();

  it("signs up, refuses an unverified sign-in, verifies, then signs in", async () => {
    const local = freshLocal();
    const response = await app.signUp(`  ${local}@Northeastern.EDU `);
    expect(await response.json()).toMatchObject({ token: null });

    const email = `${local}@northeastern.edu`;
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(
      app.mailer.to(email).filter((m) => m.template === "verify-email"),
    ).toHaveLength(1);

    const unverified = await app.signIn(email, STRONG);
    expect(unverified.response.status).toBe(403);
    expect(await unverified.response.json()).toMatchObject({
      code: "EMAIL_NOT_VERIFIED",
    });

    const verifiedCookie = await app.verify(email);
    expect(verifiedCookie).not.toBeNull();

    const { response: signedIn, cookie } = await app.signIn(email, STRONG);
    expect(signedIn.status).toBe(200);
    expect(cookie).not.toBeNull();
    const session = await app.getSession(cookie);
    expect(session.status).toBe(200);
    expect(session.body).toMatchObject({ user: { id: user.id, email } });

    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual([
      "USER_CREATED",
      "LOGIN_FAILED",
      "EMAIL_VERIFIED",
      "LOGIN_SUCCESS",
      "LOGIN_SUCCESS",
    ]);
    expect(events[0].metadata).toEqual({ source: "self_signup" });
    expect(events[1].metadata).toEqual({ reason: "EMAIL_NOT_VERIFIED" });
    expect(events[3].metadata).toEqual({ method: "email_verification" });
    expect(events[4].metadata).toEqual({ method: "password" });
  });

  it.each(["gmail.com", "sub.northeastern.edu"])(
    "rejects a sign-up from %s and creates nothing",
    async (domain) => {
      const ip = ipFor(`domain-${domain}`);
      const email = `${freshLocal()}@${domain}`;

      const response = await app.request("POST", "/sign-up/email", {
        body: { email, password: STRONG, name: "Flow Test" },
        ip,
      });

      expect(response.status).toBe(400);
      expect(await response.json()).toMatchObject({
        code: "EMAIL_DOMAIN_NOT_ALLOWED",
      });
      expect(await prisma.user.count({ where: { email } })).toBe(0);
      expect(app.mailer.to(email)).toHaveLength(0);
      expect(await auditEventsByIp(ip, "USER_CREATED")).toHaveLength(0);
    },
  );

  it("answers a wrong password and an unknown email alike", async () => {
    const user = await createUser({ password: STRONG });
    const ip = ipFor("unknown-email");

    const wrong = await app.signIn(user.email, WRONG);
    const unknown = await app.signIn(
      `nobody-${freshLocal()}@northeastern.edu`,
      WRONG,
      {
        ip,
      },
    );

    expect(wrong.response.status).toBe(401);
    expect(unknown.response.status).toBe(401);
    const wrongBody = await wrong.response.json();
    expect(wrongBody).toMatchObject({ code: "INVALID_EMAIL_OR_PASSWORD" });
    expect(await unknown.response.json()).toEqual(wrongBody);

    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual(["LOGIN_FAILED"]);
    expect(events[0]).toMatchObject({
      targetType: "USER",
      targetId: user.id,
      metadata: { reason: "INVALID_EMAIL_OR_PASSWORD" },
    });

    const strangers = await auditEventsByIp(ip, "LOGIN_FAILED");
    expect(strangers).toHaveLength(1);
    expect(strangers[0]).toMatchObject({
      targetType: null,
      targetId: null,
      metadata: { reason: "INVALID_EMAIL_OR_PASSWORD" },
    });
  });

  it("refuses a deactivated user everywhere and revokes the sessions", async () => {
    const user = await createUser({ password: STRONG });
    const { response, cookie } = await app.signIn(user.email, STRONG);
    expect(response.status).toBe(200);
    expect(cookie).not.toBeNull();

    await prisma.user.update({
      where: { id: user.id },
      data: { status: "DEACTIVATED" },
    });

    const session = await app.getSession(cookie);
    expect(session.status).toBe(401);
    expect(session.body).toMatchObject({ code: "ACCOUNT_DEACTIVATED" });
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const right = await app.signIn(user.email, STRONG);
    expect(right.response.status).toBe(403);
    expect(await right.response.json()).toMatchObject({
      code: "ACCOUNT_DEACTIVATED",
    });

    const wrong = await app.signIn(user.email, WRONG);
    expect(wrong.response.status).toBe(401);
    expect(await wrong.response.json()).toMatchObject({
      code: "INVALID_EMAIL_OR_PASSWORD",
    });

    // The revocation on get-session writes no event today, so none is expected.
    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual([
      "LOGIN_SUCCESS",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
    ]);
    expect(events[1].metadata).toEqual({ reason: "ACCOUNT_DEACTIVATED" });
    expect(events[2].metadata).toEqual({ reason: "INVALID_EMAIL_OR_PASSWORD" });
    expect(await auditTypes(user.id)).toHaveLength(3);
  });
});
