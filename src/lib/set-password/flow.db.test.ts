import { afterAll, describe, expect, it } from "vitest";
import { createSetPasswordRequestHandler } from "@/lib/set-password/request-handler";
import {
  BASE_URL,
  STRONG,
  createSetPasswordHarness,
} from "@/test/set-password-harness";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("set-password triggers, end to end", () => {
  const h = createSetPasswordHarness(url ?? "", "t22-flow");
  const deferred: Promise<void>[] = [];
  const handle = createSetPasswordRequestHandler({
    mode: "json",
    service: h.service,
    limit: async () => ({ allowed: true, retryAfterSeconds: 0 }),
    // The collector Next's `after` stands in for: run now, await later.
    defer: (task) => {
      deferred.push(task());
    },
    log: { error: () => {} },
  });

  afterAll(h.cleanup);

  async function emailStep(email: string) {
    const response = await handle(
      new Request(`${BASE_URL}/api/sgauth/sign-in/email-step`, {
        method: "POST",
        headers: { "content-type": "application/json", origin: BASE_URL },
        body: JSON.stringify({ email }),
      }),
    );
    await Promise.all(deferred.splice(0));
    return {
      status: response.status,
      body: await response.text(),
      headers: [...response.headers.entries()].sort(),
    };
  }

  // AC2: the same answer for an unknown address, a password-less account and
  // a password account, and exactly one email, to the password-less one.
  it("answers every address the same and emails only the password-less one", async () => {
    h.mailer.clear();
    const passwordless = await h.createPasswordless();
    const holder = await h.createWithPassword();
    const unknown = h.freshEmail();

    const answers = [
      await emailStep(passwordless.email),
      await emailStep(unknown),
      await emailStep(holder.email),
    ];

    expect(answers[0].status).toBe(200);
    expect(answers[0].body).toBe(JSON.stringify({ ok: true }));
    expect(answers[1]).toEqual(answers[0]);
    expect(answers[2]).toEqual(answers[0]);

    expect(h.mailer.sent).toHaveLength(1);
    expect(h.mailer.sent[0].to).toBe(passwordless.email);
    expect(h.mailer.sent[0].template).toBe("set-password");
  });

  it("sends a set-password email, and answers the generic duplicate, for a self-sign-up of a password-less address", async () => {
    h.mailer.clear();
    const user = await h.createPasswordless();
    const fresh = h.freshEmail();

    const duplicate = await h.auth.api.signUpEmail({
      body: { email: user.email, password: STRONG, name: "Someone Else" },
    });
    const created = await h.auth.api.signUpEmail({
      body: { email: fresh, password: STRONG, name: "New Person" },
    });

    expect(Object.keys(duplicate).sort()).toEqual(Object.keys(created).sort());
    expect(duplicate.token).toBeNull();

    expect(h.mailer.to(user.email)).toHaveLength(1);
    expect(h.linkTo(user.email)).toMatchObject({
      template: "set-password",
      data: { kind: "first-sign-in" },
    });
    expect(await h.prisma.user.count({ where: { email: user.email } })).toBe(1);
    expect(
      await h.prisma.account.count({
        where: { userId: user.id, providerId: "credential" },
      }),
    ).toBe(0);
    expect(
      await h.prisma.auditEvent.count({
        where: {
          type: "PASSWORD_SET_REQUESTED",
          targetId: user.id,
          metadata: { path: ["via"], equals: "sign_up" },
        },
      }),
    ).toBe(1);
  });

  it("sends nothing for a self-sign-up of an address that has a password", async () => {
    h.mailer.clear();
    const holder = await h.createWithPassword();
    await h.auth.api.signUpEmail({
      body: { email: holder.email, password: STRONG, name: "Someone Else" },
    });
    expect(h.mailer.to(holder.email)).toEqual([]);
  });
});
