import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  STRONG,
  WRONG,
  auditEvents,
  createAuthHttpApp,
  type AuthHttpApp,
} from "@/test/auth-http";
import { createSession, createUser } from "@/test/factories";

const NEW = "a-brand-new-password-1";

const resetEmails = (app: AuthHttpApp, email: string) =>
  app.mailer
    .to(email)
    .filter((message) => message.template === "reset-password");

async function requestReset(app: AuthHttpApp, email: string) {
  const response = await app.request("POST", "/request-password-reset", {
    body: { email },
  });
  await app.drain();
  return response;
}

function tokenOf(app: AuthHttpApp, email: string): string {
  const message = resetEmails(app, email).at(-1);
  const link = new URL(String(message?.data.url));
  expect(link.pathname).toBe("/reset-password");
  const token = link.searchParams.get("token");
  if (!token) throw new Error("no token in the emailed link");
  return token;
}

const reset = (app: AuthHttpApp, token: string, newPassword = NEW) =>
  app.request("POST", "/reset-password", { body: { token, newPassword } });

describe("password reset over HTTP", () => {
  it("answers an existing and an unknown address alike and mails only the existing one", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });
    const unknown = `nobody-reset-${Math.random().toString(36).slice(2, 10)}@northeastern.edu`;

    const known = await requestReset(app, user.email);
    const stranger = await requestReset(app, unknown);

    expect(known.status).toBe(200);
    expect(stranger.status).toBe(200);
    expect(await stranger.json()).toEqual(await known.json());
    expect(resetEmails(app, user.email)).toHaveLength(1);
    expect(app.mailer.to(unknown)).toHaveLength(0);
  });

  it("revokes every session, burns the token and mails a notice", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });
    const a = await app.signIn(user.email, STRONG);
    const b = await app.signIn(user.email, STRONG);
    await createSession(user);
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(3);

    await requestReset(app, user.email);
    const token = tokenOf(app, user.email);
    const done = await reset(app, token);
    expect(done.status).toBe(200);

    expect((await app.getSession(a.cookie)).body).toBeNull();
    expect((await app.getSession(b.cookie)).body).toBeNull();
    expect(await prisma.session.count({ where: { userId: user.id } })).toBe(0);

    const old = await app.signIn(user.email, STRONG);
    expect(old.response.status).toBe(401);
    expect((await app.signIn(user.email, NEW)).response.status).toBe(200);

    const replay = await reset(app, token, "another-new-password-2");
    expect(replay.status).toBe(400);
    expect(await replay.json()).toMatchObject({ code: "INVALID_TOKEN" });

    await app.drain();
    const notices = app.mailer
      .to(user.email)
      .filter((message) => message.template === "security-notice");
    expect(notices).toHaveLength(1);
    expect(notices[0].data).toMatchObject({ event: "password-reset" });

    expect((await auditEvents(user.id)).map((event) => event.type)).toEqual([
      "LOGIN_SUCCESS",
      "LOGIN_SUCCESS",
      "PASSWORD_RESET_REQUESTED",
      "PASSWORD_RESET",
      "LOGIN_FAILED",
      "LOGIN_SUCCESS",
    ]);
  });

  it("clears an account lock", async () => {
    const app = createAuthHttpApp();
    const user = await createUser({ password: STRONG });
    for (let i = 0; i < 5; i++) {
      expect((await app.signIn(user.email, WRONG)).response.status).toBe(401);
    }

    await requestReset(app, user.email);
    expect((await reset(app, tokenOf(app, user.email))).status).toBe(200);

    const signedIn = await app.signIn(user.email, NEW);
    expect(signedIn.response.status).toBe(200);

    const events = await auditEvents(user.id);
    expect(events.map((event) => event.type)).toEqual([
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "LOGIN_FAILED",
      "ACCOUNT_LOCKED",
      "PASSWORD_RESET_REQUESTED",
      "PASSWORD_RESET",
      "ACCOUNT_UNLOCKED",
      "LOGIN_SUCCESS",
    ]);
    expect(events[8].metadata).toEqual({ method: "password_reset" });
  });
});
