import { afterAll, describe, expect, it, vi } from "vitest";
import { createTokenActionHandler } from "@/lib/token-links/handler";
import {
  createSetPasswordConsumer,
  loadSetPasswordView,
  setPasswordFields,
} from "@/lib/set-password/consumer";
import { issueSetPasswordToken } from "@/lib/set-password/token";
import {
  BASE_URL,
  STRONG,
  createSetPasswordHarness,
} from "@/test/set-password-harness";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const NEW_PASSWORD = "a-brand-new-passphrase";

describe.skipIf(!url)("consuming a set-password link", () => {
  const h = createSetPasswordHarness(url ?? "", "t22-consumer");
  const log = { error: vi.fn() };
  const handle = createTokenActionHandler({
    action: "set-password",
    fields: setPasswordFields,
    consume: createSetPasswordConsumer({
      prisma: h.prisma,
      auth: h.auth,
      now: () => new Date(),
    }),
    limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    log,
  });

  afterAll(h.cleanup);

  async function issue(userId: string, now = new Date()) {
    const { token } = await issueSetPasswordToken(h.prisma, {
      userId,
      kind: "first-sign-in",
      now,
    });
    return token;
  }

  function post(
    token: string,
    fields: { password?: string; confirmPassword?: string } = {},
  ) {
    const password = fields.password ?? NEW_PASSWORD;
    return new Request(`${BASE_URL}/set-password/confirm`, {
      method: "POST",
      headers: {
        "content-type": "application/x-www-form-urlencoded",
        origin: BASE_URL,
      },
      body: new URLSearchParams({
        token,
        password,
        confirmPassword: fields.confirmPassword ?? password,
      }).toString(),
    });
  }

  const location = (response: Response) =>
    new URL(response.headers.get("location") ?? "");
  const result = (response: Response) =>
    location(response).searchParams.get("result");

  const view = (token: string) =>
    loadSetPasswordView({ token }, { prisma: h.prisma, now: new Date() });

  const credential = (userId: string) =>
    h.prisma.account.findMany({
      where: { userId, providerId: "credential" },
    });

  const events = (
    type: "PASSWORD_SET" | "LOGIN_SUCCESS" | "LOGIN_FAILED",
    id: string,
  ) =>
    h.prisma.auditEvent.count({
      where: { type, OR: [{ targetId: id }, { actorUserId: id }] },
    });

  // AC1
  it("refuses any password for a password-less account until one is set", async () => {
    const user = await h.createPasswordless();
    for (const password of [STRONG, NEW_PASSWORD, "x".repeat(20)]) {
      const error = await h.auth.api
        .signInEmail({ body: { email: user.email, password } })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(error).toMatchObject({
        statusCode: 401,
        body: { code: "INVALID_EMAIL_OR_PASSWORD" },
      });
    }
    expect(await events("LOGIN_FAILED", user.id)).toBe(3);
  });

  it("shows the form without changing a row, then sets the password and signs in", async () => {
    const user = await h.createPasswordless();
    await h.prisma.user.update({
      where: { id: user.id },
      data: { emailVerified: false },
    });
    const token = await issue(user.id);
    const before = await h.prisma.verification.findMany({
      where: { value: user.id },
    });

    expect(await view(token)).toEqual({
      state: "ready",
      token,
      email: user.email,
      fieldError: false,
    });
    expect(
      await h.prisma.verification.findMany({ where: { value: user.id } }),
    ).toEqual(before);

    const response = await handle(post(token));
    expect(response.status).toBe(303);
    expect(result(response)).toBe("done");
    expect(location(response).searchParams.get("signedIn")).toBe("1");
    expect(response.headers.getSetCookie().join(";")).toContain(
      "session_token",
    );

    const after = await h.prisma.user.findUniqueOrThrow({
      where: { id: user.id },
    });
    expect(after.id).toBe(user.id);
    expect(after.emailVerified).toBe(true);
    expect(after.passwordChangedAt).not.toBeNull();
    expect(await credential(user.id)).toHaveLength(1);
    expect(await events("PASSWORD_SET", user.id)).toBe(1);
    expect(await events("LOGIN_SUCCESS", user.id)).toBe(1);
    expect(
      await h.auth.api.signInEmail({
        body: { email: user.email, password: NEW_PASSWORD },
      }),
    ).toMatchObject({ user: { id: user.id } });
  });

  it("answers a second POST with the same token invalid and keeps the password", async () => {
    const user = await h.createPasswordless();
    const token = await issue(user.id);
    expect(result(await handle(post(token)))).toBe("done");
    const [first] = await credential(user.id);

    expect(result(await handle(post(token, { password: STRONG })))).toBe(
      "invalid",
    );
    const [second] = await credential(user.id);
    expect(second.password).toBe(first.password);
    expect((await view(token)).state).toBe("invalid");
  });

  it("lets exactly one of two concurrent POSTs win", async () => {
    const user = await h.createPasswordless();
    const token = await issue(user.id);
    const responses = await Promise.all([
      handle(post(token)),
      handle(post(token)),
    ]);
    expect(responses.map(result).sort()).toEqual(["done", "invalid"]);
    expect(await credential(user.id)).toHaveLength(1);
    expect(await events("PASSWORD_SET", user.id)).toBe(1);
  });

  it("refuses a user who already has a password and leaves the hash alone", async () => {
    const user = await h.createWithPassword();
    const [before] = await credential(user.id);
    const token = await issue(user.id);

    expect((await view(token)).state).toBe("invalid");
    expect(result(await handle(post(token)))).toBe("invalid");
    const [after] = await credential(user.id);
    expect(after.password).toBe(before.password);
    expect(await events("PASSWORD_SET", user.id)).toBe(0);
  });

  it("refuses a deactivated user and writes no credential", async () => {
    const user = await h.createPasswordless({ status: "DEACTIVATED" });
    const token = await issue(user.id);

    expect((await view(token)).state).toBe("invalid");
    expect(result(await handle(post(token)))).toBe("invalid");
    expect(await credential(user.id)).toEqual([]);
  });

  it("shows an expired token as invalid and refuses its POST", async () => {
    const user = await h.createPasswordless();
    const token = await issue(user.id, new Date(Date.now() - 2 * 60 * 60_000));

    expect((await view(token)).state).toBe("invalid");
    expect(result(await handle(post(token)))).toBe("invalid");
    expect(await credential(user.id)).toEqual([]);
  });

  it("sends mismatched passwords back to the form with the token still valid", async () => {
    const user = await h.createPasswordless();
    const token = await issue(user.id);

    const response = await handle(
      post(token, { confirmPassword: "different" }),
    );
    expect(response.status).toBe(303);
    expect(location(response).searchParams.get("error")).toBe("fields");
    expect(location(response).searchParams.get("token")).toBe(token);
    expect(await credential(user.id)).toEqual([]);
    expect(await view(token)).toMatchObject({ state: "ready" });
  });

  it("updates an imported credential Account with a null password", async () => {
    const user = await h.createPasswordless();
    const imported = await h.prisma.account.create({
      data: {
        userId: user.id,
        providerId: "credential",
        accountId: user.id,
        password: null,
      },
    });
    const token = await issue(user.id);

    expect(result(await handle(post(token)))).toBe("done");
    const accounts = await credential(user.id);
    expect(accounts).toHaveLength(1);
    expect(accounts[0].id).toBe(imported.id);
    expect(accounts[0].password).not.toBeNull();
  });
});
