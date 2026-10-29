import { randomBytes } from "node:crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";
import { PrismaClient } from "@/generated/prisma/client";
import type { AuthzSubject } from "@/lib/authz";
import {
  EMAIL_CHANGE_TTL_MS,
  createEmailChangeService,
  hashEmailChangeToken,
} from "@/lib/email-change/service";
import type { SendResult } from "@/lib/email/mailer";
import { tombstoneUser } from "@/lib/users/tombstone";
import { createCapturingMailer } from "@/test/capturing-mailer";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const ORIGIN = "http://localhost:3000";
const CONTEXT = { ip: "203.0.113.7", userAgent: "vitest" };

describe.skipIf(!url)("email change service", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url ?? "" }),
  });
  const mailer = createCapturingMailer();
  let mailResult: SendResult = { status: "sent" };
  let clock = new Date();
  const log = { error: vi.fn() };

  const service = createEmailChangeService({
    prisma,
    mailer: {
      sendEmail: async (message) => {
        const result = await mailer.sendEmail(message);
        return result.status === "sent" ? mailResult : result;
      },
    },
    linkOrigin: ORIGIN,
    log,
    now: () => clock,
  });

  const rand = randomBytes(4).toString("hex");
  let counter = 0;
  const freshEmail = (domain = "northeastern.edu") =>
    `t24-${counter++}-${rand}@${domain}`;

  const createUser = (
    data: { isAdmin?: boolean; legacyEmail?: boolean; email?: string } = {},
  ) =>
    prisma.user.create({
      data: {
        email: data.email ?? freshEmail(),
        name: "Test User",
        emailVerified: true,
        status: "ACTIVE",
        isAdmin: data.isAdmin ?? false,
        legacyEmail: data.legacyEmail ?? false,
      },
    });

  const subject = (user: {
    id: string;
    isAdmin: boolean;
    isPrimaryAdmin: boolean;
    status: "ACTIVE" | "DEACTIVATED" | "DELETED";
  }): AuthzSubject => user;

  // The Primary Admin is a literal: a real one can never be deleted, and the
  // service only reads the actor's flags.
  const primaryAdmin: AuthzSubject = {
    id: `pa-${rand}`,
    isAdmin: true,
    isPrimaryAdmin: true,
    status: "ACTIVE",
  };

  const tokenFrom = (to: string) => {
    const message = mailer
      .to(to)
      .filter((m) => m.template === "email-change-verify")
      .at(-1);
    const token = new URL(String(message?.data.url)).searchParams.get("token");
    if (!token) throw new Error("no email-change link was mailed");
    return token;
  };

  const events = (type: string, targetId: string) =>
    prisma.auditEvent.findMany({ where: { type, targetId } });

  beforeEach(() => {
    mailer.clear();
    mailResult = { status: "sent" };
    clock = new Date();
    log.error.mockClear();
  });

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: rand } },
      select: { id: true },
    });
    await prisma.verification.deleteMany({
      where: { value: { in: users.map((user) => user.id) } },
    });
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function request(
    actor: AuthzSubject,
    target: { id: string },
    newEmail = freshEmail("gmail.com"),
  ) {
    const result = await service.requestEmailChange({
      actor,
      targetId: target.id,
      newEmail,
      requestContext: CONTEXT,
    });
    return { result, newEmail };
  }

  describe("requestEmailChange", () => {
    it("stores a hashed pending request, mails both addresses and audits it", async () => {
      const admin = await createUser({ isAdmin: true });
      const user = await createUser();
      const { result, newEmail } = await request(subject(admin), user);

      expect(result).toEqual({
        ok: true,
        expiresAt: new Date(clock.getTime() + EMAIL_CHANGE_TTL_MS),
      });
      // Nothing on the user changes until the link is confirmed.
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.email).toBe(user.email);

      const token = tokenFrom(newEmail);
      const row = await prisma.emailChangeRequest.findUniqueOrThrow({
        where: { tokenHash: hashEmailChangeToken(token) },
      });
      expect(row).toMatchObject({
        userId: user.id,
        newEmail,
        requestedById: admin.id,
        consumedAt: null,
        cancelledAt: null,
      });
      expect(row.tokenHash).not.toContain(token);

      expect(mailer.to(newEmail)).toHaveLength(1);
      const verify = mailer.to(newEmail)[0];
      expect(verify.data).toMatchObject({ expiresInMinutes: 1440 });
      expect(JSON.stringify(verify)).not.toContain(user.email);
      expect(String(verify.data.url)).toMatch(
        new RegExp(`^${ORIGIN}/verify-email-change\\?token=`),
      );
      const notice = mailer.to(user.email);
      expect(notice).toHaveLength(1);
      expect(notice[0].template).toBe("email-change-notice");
      // The notice goes to the old address and carries no link.
      expect(notice[0].data).not.toHaveProperty("url");

      const [event] = await events("EMAIL_CHANGE_REQUESTED", user.id);
      expect(event).toMatchObject({
        actorType: "USER",
        actorUserId: admin.id,
        ip: CONTEXT.ip,
        userAgent: CONTEXT.userAgent,
        metadata: {
          requestId: row.id,
          fromEmail: user.email,
          toEmail: newEmail,
        },
      });
      expect(JSON.stringify(event)).not.toContain(token);
    });

    it("replaces an open request, which then reads as invalid", async () => {
      const admin = await createUser({ isAdmin: true });
      const user = await createUser();
      const first = await request(subject(admin), user);
      const firstToken = tokenFrom(first.newEmail);
      const second = await request(subject(admin), user);
      const secondToken = tokenFrom(second.newEmail);

      expect(await service.peekEmailChange(firstToken)).toEqual({
        state: "invalid",
      });
      expect(await service.peekEmailChange(secondToken)).toEqual({
        state: "valid",
        newEmail: second.newEmail,
      });
      const open = await prisma.emailChangeRequest.count({
        where: { userId: user.id, consumedAt: null, cancelledAt: null },
      });
      expect(open).toBe(1);

      const logged = await events("EMAIL_CHANGE_REQUESTED", user.id);
      expect(logged).toHaveLength(2);
      const firstRow = await prisma.emailChangeRequest.findUniqueOrThrow({
        where: { tokenHash: hashEmailChangeToken(firstToken) },
      });
      expect(
        logged.some(
          (event) =>
            (event.metadata as Record<string, unknown>).supersededRequestId ===
            firstRow.id,
        ),
      ).toBe(true);
    });

    it("refuses an address in use, by anyone, without naming the owner", async () => {
      const admin = await createUser({ isAdmin: true });
      const user = await createUser();
      const other = await createUser();

      for (const taken of [other.email, other.email.toUpperCase()]) {
        const { result } = await request(subject(admin), user, taken);
        expect(result).toEqual({ ok: false, code: "EMAIL_UNAVAILABLE" });
        expect(JSON.stringify(result)).not.toContain(other.id);
      }
      expect(mailer.sent).toEqual([]);
      expect(
        await prisma.emailChangeRequest.count({ where: { userId: user.id } }),
      ).toBe(0);
      expect(await events("EMAIL_CHANGE_REQUESTED", user.id)).toEqual([]);
    });

    it("refuses the user's current address as unchanged", async () => {
      const admin = await createUser({ isAdmin: true });
      const user = await createUser();
      const { result } = await request(
        subject(admin),
        user,
        ` ${user.email.toUpperCase()} `,
      );
      expect(result).toEqual({ ok: false, code: "EMAIL_UNCHANGED" });
    });

    it("lets an admin change a non-admin, and refuses another admin", async () => {
      const admin = await createUser({ isAdmin: true });
      const otherAdmin = await createUser({ isAdmin: true });
      const user = await createUser();

      expect((await request(subject(admin), user)).result.ok).toBe(true);
      const denied = await request(subject(admin), otherAdmin);
      expect(denied.result).toEqual({
        ok: false,
        code: "FORBIDDEN",
        reason: "PRIMARY_ADMIN_REQUIRED",
      });
      expect(
        await prisma.emailChangeRequest.count({
          where: { userId: otherAdmin.id },
        }),
      ).toBe(0);
      expect(mailer.to(denied.newEmail)).toEqual([]);
    });

    it("lets the Primary Admin change another admin", async () => {
      const otherAdmin = await createUser({ isAdmin: true });
      const { result } = await request(primaryAdmin, otherAdmin);
      expect(result.ok).toBe(true);
    });

    it("refuses a non-admin actor, a missing target and a deleted one", async () => {
      const user = await createUser();
      const target = await createUser();
      expect(
        (await request(subject({ ...user, isPrimaryAdmin: false }), target))
          .result,
      ).toEqual({
        ok: false,
        code: "FORBIDDEN",
        reason: "NOT_ADMIN",
      });

      expect(
        (
          await request(primaryAdmin, {
            id: "00000000-0000-4000-8000-000000000000",
          })
        ).result,
      ).toEqual({ ok: false, code: "NOT_FOUND" });

      const deleted = await createUser();
      await prisma.user.update({
        where: { id: deleted.id },
        data: { status: "DELETED" },
      });
      expect((await request(primaryAdmin, deleted)).result).toEqual({
        ok: false,
        code: "USER_DELETED",
      });
    });

    it("cancels the request and says so when the mail cap refuses the link", async () => {
      const user = await createUser();
      mailResult = { status: "capped", cap: "recipient:1h" };
      const { result, newEmail } = await request(primaryAdmin, user);
      expect(result).toEqual({ ok: false, code: "EMAIL_SEND_LIMITED" });

      const row = await prisma.emailChangeRequest.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row.cancelledAt).not.toBeNull();
      // The notice is not sent for a request that never went out.
      expect(mailer.to(user.email)).toEqual([]);
      expect(await service.peekEmailChange(tokenFrom(newEmail))).toEqual({
        state: "invalid",
      });
      // The audit log is append-only, so the request stays recorded.
      expect(await events("EMAIL_CHANGE_REQUESTED", user.id)).toHaveLength(1);
    });

    it("cancels the request and throws when the verify mail fails", async () => {
      const user = await createUser();
      mailResult = { status: "failed" };
      await expect(request(primaryAdmin, user)).rejects.toThrow();
      const row = await prisma.emailChangeRequest.findFirstOrThrow({
        where: { userId: user.id },
      });
      expect(row.cancelledAt).not.toBeNull();
    });
  });

  describe("peekEmailChange", () => {
    it("reads without writing, and tells valid, expired, used and invalid apart", async () => {
      const user = await createUser();
      const { newEmail } = await request(primaryAdmin, user);
      const token = tokenFrom(newEmail);
      const tokenHash = hashEmailChangeToken(token);

      expect(await service.peekEmailChange(token)).toEqual({
        state: "valid",
        newEmail,
      });
      await service.peekEmailChange(token);
      const row = await prisma.emailChangeRequest.findUniqueOrThrow({
        where: { tokenHash },
      });
      expect(row.consumedAt).toBeNull();

      expect(await service.peekEmailChange("not-a-token")).toEqual({
        state: "invalid",
      });

      clock = new Date(clock.getTime() + EMAIL_CHANGE_TTL_MS + 1000);
      expect(await service.peekEmailChange(token)).toEqual({
        state: "expired",
      });
    });
  });

  describe("confirmEmailChange", () => {
    it("swaps the address, signs the user out, voids old-address tokens and audits it", async () => {
      const user = await createUser({
        email: freshEmail("gmail.com"),
        legacyEmail: true,
      });
      await prisma.session.createMany({
        data: ["a", "b"].map((name) => ({
          token: `${name}-${rand}-${randomBytes(6).toString("hex")}`,
          userId: user.id,
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      });
      await prisma.verification.createMany({
        data: [
          // A reset token (hashed identifier) and a set-password token.
          { identifier: `hash-${rand}`, value: user.id },
          { identifier: `set-password:${rand}`, value: user.id },
        ].map((row) => ({
          ...row,
          expiresAt: new Date(Date.now() + 3_600_000),
        })),
      });
      await prisma.unlockToken.create({
        data: {
          userId: user.id,
          tokenHash: hashEmailChangeToken(`unlock-${rand}`),
          expiresAt: new Date(Date.now() + 3_600_000),
        },
      });

      const nuEmail = freshEmail();
      const { result } = await request(primaryAdmin, user, nuEmail);
      expect(result.ok).toBe(true);
      const token = tokenFrom(nuEmail);

      expect(await service.confirmEmailChange(token)).toEqual({
        state: "done",
        newEmail: nuEmail,
      });

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after).toMatchObject({
        email: nuEmail,
        emailVerified: true,
        legacyEmail: false,
      });
      // The old address no longer finds the account.
      expect(
        await prisma.user.findUnique({ where: { email: user.email } }),
      ).toBeNull();
      expect(await prisma.session.count({ where: { userId: user.id } })).toBe(
        0,
      );
      expect(
        await prisma.verification.count({ where: { value: user.id } }),
      ).toBe(0);
      expect(
        await prisma.unlockToken.count({
          where: { userId: user.id, usedAt: null },
        }),
      ).toBe(0);

      const [event] = await events("EMAIL_CHANGED", user.id);
      expect(event).toMatchObject({
        actorType: "SYSTEM",
        actorUserId: null,
        metadata: {
          requestedById: primaryAdmin.id,
          fromEmail: user.email,
          toEmail: nuEmail,
          legacyEmail: { from: true, to: false },
          sessionsRevoked: 2,
        },
      });

      // A second press says so, and writes nothing more.
      expect(await service.confirmEmailChange(token)).toEqual({
        state: "used",
      });
      expect(await events("EMAIL_CHANGED", user.id)).toHaveLength(1);
    });

    it("sets legacyEmail when an NU account moves to a personal address", async () => {
      const user = await createUser();
      const { newEmail } = await request(primaryAdmin, user);
      await service.confirmEmailChange(tokenFrom(newEmail));
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.legacyEmail).toBe(true);
    });

    it("answers unavailable, and keeps the request open, when the address was taken meanwhile", async () => {
      const user = await createUser();
      const { newEmail } = await request(primaryAdmin, user);
      const token = tokenFrom(newEmail);
      await createUser({ email: newEmail });

      expect(await service.confirmEmailChange(token)).toEqual({
        state: "unavailable",
      });
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.email).toBe(user.email);
      expect(await events("EMAIL_CHANGED", user.id)).toEqual([]);
      const row = await prisma.emailChangeRequest.findUniqueOrThrow({
        where: { tokenHash: hashEmailChangeToken(token) },
      });
      expect(row.consumedAt).toBeNull();
    });

    it("refuses an expired, an unknown and a superseded link", async () => {
      const user = await createUser();
      const first = await request(primaryAdmin, user);
      const firstToken = tokenFrom(first.newEmail);
      const second = await request(primaryAdmin, user);
      const secondToken = tokenFrom(second.newEmail);

      expect(await service.confirmEmailChange(firstToken)).toEqual({
        state: "invalid",
      });
      expect(await service.confirmEmailChange("nope")).toEqual({
        state: "invalid",
      });
      clock = new Date(clock.getTime() + EMAIL_CHANGE_TTL_MS + 1000);
      expect(await service.confirmEmailChange(secondToken)).toEqual({
        state: "expired",
      });
      const after = await prisma.user.findUniqueOrThrow({
        where: { id: user.id },
      });
      expect(after.email).toBe(user.email);
    });

    it("refuses a link whose user was deleted", async () => {
      const user = await createUser();
      const { newEmail } = await request(primaryAdmin, user);
      const token = tokenFrom(newEmail);
      await prisma.user.update({
        where: { id: user.id },
        data: { status: "DELETED" },
      });
      expect(await service.confirmEmailChange(token)).toEqual({
        state: "invalid",
      });
      const row = await prisma.emailChangeRequest.findUniqueOrThrow({
        where: { tokenHash: hashEmailChangeToken(token) },
      });
      expect(row.consumedAt).toBeNull();
    });

    it("lets exactly one of two concurrent presses win", async () => {
      const user = await createUser();
      const { newEmail } = await request(primaryAdmin, user);
      const token = tokenFrom(newEmail);

      const results = await Promise.all([
        service.confirmEmailChange(token),
        service.confirmEmailChange(token),
      ]);
      expect(results.filter((r) => r.state === "done")).toHaveLength(1);
      expect(await events("EMAIL_CHANGED", user.id)).toHaveLength(1);
    });
  });

  describe("tombstone", () => {
    it("scrubs both addresses from the user's email-change audit rows and drops the pending request", async () => {
      const user = await createUser();
      const { newEmail } = await request(primaryAdmin, user);
      await service.confirmEmailChange(tokenFrom(newEmail));
      const pendingEmail = freshEmail("gmail.com");
      await request(primaryAdmin, user, pendingEmail);

      await tombstoneUser(prisma, {
        userId: user.id,
        reason: "admin",
        actor: { actorType: "SYSTEM" },
      });

      const rows = [
        ...(await events("EMAIL_CHANGE_REQUESTED", user.id)),
        ...(await events("EMAIL_CHANGED", user.id)),
      ];
      expect(rows).toHaveLength(3);
      for (const row of rows) {
        expect(row.metadata).not.toHaveProperty("fromEmail");
        expect(row.metadata).not.toHaveProperty("toEmail");
        expect(row.metadata).toHaveProperty("requestId");
      }
      expect(
        await prisma.emailChangeRequest.count({ where: { userId: user.id } }),
      ).toBe(0);
    });
  });
});
