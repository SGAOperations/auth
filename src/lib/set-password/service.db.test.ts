import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { hasPassword } from "@/lib/set-password/service";
import {
  BASE_URL,
  createSetPasswordHarness,
} from "@/test/set-password-harness";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("set-password service", () => {
  const h = createSetPasswordHarness(url ?? "", "t22-service");

  beforeEach(() => {
    h.allowAll();
    h.mailer.clear();
    h.log.info.mockClear();
  });

  afterAll(h.cleanup);

  const requested = (userId: string) =>
    h.prisma.auditEvent.findMany({
      where: { type: "PASSWORD_SET_REQUESTED", targetId: userId },
    });

  const tokenRows = (userId: string) =>
    h.prisma.verification.count({
      where: { value: userId, identifier: { startsWith: "set-password:" } },
    });

  describe("hasPassword", () => {
    it("is false with no credential Account", async () => {
      const user = await h.createPasswordless();
      expect(await hasPassword(h.prisma, user.id)).toBe(false);
    });

    it("is false for an imported credential Account with a null password", async () => {
      const user = await h.createPasswordless();
      await h.prisma.account.create({
        data: {
          userId: user.id,
          providerId: "credential",
          accountId: user.id,
          password: null,
        },
      });
      expect(await hasPassword(h.prisma, user.id)).toBe(false);
    });

    it("is true with a credential password", async () => {
      const user = await h.createWithPassword();
      expect(await hasPassword(h.prisma, user.id)).toBe(true);
    });
  });

  describe("requestLink", () => {
    it("emails one first-sign-in link and audits it", async () => {
      const user = await h.createPasswordless();
      await h.service.requestLink({ email: user.email, via: "sign_in" });

      expect(h.mailer.to(user.email)).toHaveLength(1);
      const message = h.linkTo(user.email);
      expect(message?.template).toBe("set-password");
      expect(message?.data).toMatchObject({
        kind: "first-sign-in",
        expiresInMinutes: 60,
        name: user.name,
      });
      expect(String(message?.data.url)).toMatch(
        new RegExp(`^${BASE_URL}/set-password\\?token=`),
      );

      const events = await requested(user.id);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: "SYSTEM",
        actorUserId: null,
        metadata: { via: "sign_in" },
      });
      expect(JSON.stringify(events[0])).not.toContain(user.email);
      expect(await tokenRows(user.id)).toBe(1);
    });

    it("normalizes the address", async () => {
      const user = await h.createPasswordless();
      await h.service.requestLink({
        email: `  ${user.email.toUpperCase()} `,
        via: "link_request",
      });
      expect(h.mailer.to(user.email)).toHaveLength(1);
      expect((await requested(user.id))[0]).toMatchObject({
        metadata: { via: "link_request" },
      });
    });

    it("greets by preferred name when there is one", async () => {
      const user = await h.createPasswordless();
      await h.prisma.user.update({
        where: { id: user.id },
        data: { preferredName: "Pat" },
      });
      await h.service.requestLink({ email: user.email, via: "sign_in" });
      expect(h.linkTo(user.email)?.data.name).toBe("Pat");
    });

    it("does nothing for an unknown address", async () => {
      await h.service.requestLink({
        email: h.freshEmail(),
        via: "sign_in",
      });
      expect(h.mailer.sent).toEqual([]);
    });

    it("does nothing for a user who has a password", async () => {
      const user = await h.createWithPassword();
      await h.service.requestLink({ email: user.email, via: "sign_in" });
      expect(h.mailer.sent).toEqual([]);
      expect(await requested(user.id)).toEqual([]);
      expect(await tokenRows(user.id)).toBe(0);
    });

    it("does nothing for a deactivated user", async () => {
      const user = await h.createPasswordless({ status: "DEACTIVATED" });
      await h.service.requestLink({ email: user.email, via: "sign_in" });
      expect(h.mailer.sent).toEqual([]);
      expect(await requested(user.id)).toEqual([]);
      expect(await tokenRows(user.id)).toBe(0);
    });

    it("sends no email, token or audit row when the account is over its limit", async () => {
      const user = await h.createPasswordless();
      h.deny("setPasswordLink");
      await h.service.requestLink({ email: user.email, via: "sign_in" });

      expect(h.mailer.sent).toEqual([]);
      expect(await tokenRows(user.id)).toBe(0);
      expect(await requested(user.id)).toEqual([]);
      expect(h.log.info).toHaveBeenCalledExactlyOnceWith(
        "set_password_link_limited",
        { via: "sign_in" },
      );
    });

    it("lets only the newest of two links work", async () => {
      const user = await h.createPasswordless();
      await h.service.requestLink({ email: user.email, via: "sign_in" });
      await h.service.requestLink({ email: user.email, via: "link_request" });

      expect(h.mailer.to(user.email)).toHaveLength(2);
      expect(await tokenRows(user.id)).toBe(1);
    });
  });

  describe("issueAdminInvite", () => {
    it("returns a 7-day link and sends and audits nothing", async () => {
      const user = await h.createPasswordless();
      const result = await h.service.issueAdminInvite(h.prisma, {
        userId: user.id,
        now: new Date(),
      });

      expect(result).toMatchObject({ ok: true, expiresInMinutes: 10080 });
      if (!result.ok) throw new Error("unreachable");
      expect(result.url).toMatch(
        new RegExp(`^${BASE_URL}/set-password\\?token=`),
      );
      expect(h.mailer.sent).toEqual([]);
      expect(await requested(user.id)).toEqual([]);
      expect(await tokenRows(user.id)).toBe(1);
    });

    it("is refused over the per-user limit and mints no token", async () => {
      const user = await h.createPasswordless();
      h.deny("setPasswordInvite");
      expect(
        await h.service.issueAdminInvite(h.prisma, {
          userId: user.id,
          now: new Date(),
        }),
      ).toEqual({ ok: false, reason: "RATE_LIMITED" });
      expect(await tokenRows(user.id)).toBe(0);
    });
  });

  // AC3: an import sends no email and issues no link.
  it("sends zero emails and issues zero tokens for 500 imported users", async () => {
    const stamp = Date.now();
    const imported = Array.from({ length: 500 }, (_, i) => ({
      email: `t22-import-${i}-${stamp}-${h.rand}@northeastern.edu`,
      name: `Imported ${i}`,
      emailVerified: true,
    }));
    await h.prisma.user.createMany({ data: imported });

    // The creation path with no endpoint context, as a script takes it.
    const context = await h.auth.$context;
    const created = await Promise.all(
      Array.from({ length: 5 }, (_, i) =>
        context.internalAdapter.createUser(
          {
            email: `t22-hook-${i}-${stamp}-${h.rand}@northeastern.edu`,
            name: `Hooked ${i}`,
            emailVerified: true,
          },
          { method: "admin" },
        ),
      ),
    );

    expect(h.mailer.sent).toEqual([]);
    const users = await h.prisma.user.findMany({
      where: { email: { contains: `${stamp}-${h.rand}` } },
      select: { id: true },
    });
    expect(users).toHaveLength(505);
    expect(created).toHaveLength(5);
    expect(
      await h.prisma.verification.count({
        where: {
          value: { in: users.map((user) => user.id) },
          identifier: { startsWith: "set-password:" },
        },
      }),
    ).toBe(0);
  });
});
