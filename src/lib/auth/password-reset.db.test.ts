import { createHash } from "node:crypto";
import { afterAll, describe, expect, it } from "vitest";
import bcrypt from "bcryptjs";
import { betterAuth } from "better-auth";
import { hashPassword } from "better-auth/crypto";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { LEGACY_BCRYPT_PREFIX } from "@/lib/auth/legacy-password";
import { buildAuthOptions } from "@/lib/auth/options";
import {
  isResetTokenUsable,
  resetTokenStoredIdentifier,
} from "@/lib/auth/password-reset";
import { createCapturingMailer } from "@/test/capturing-mailer";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const SECRET = "s".repeat(32);
const BASE_URL = "http://localhost:3000";
const OLD = "correct-horse-battery-staple";
const NEW = "a-brand-new-password-1";
const HOUR_MS = 60 * 60 * 1000;

describe.skipIf(!url)("password reset", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  const mailer = createCapturingMailer();
  // Background tasks are held, as in production, and awaited by `settle`.
  const background: Promise<unknown>[] = [];
  const auth = betterAuth(
    buildAuthOptions({
      prisma,
      baseURL: BASE_URL,
      secret: SECRET,
      lockout: {
        mailer,
        deviceCookie: { name: "sgauth-local.device", secure: false },
      },
      advanced: {
        backgroundTasks: { handler: (task) => void background.push(task) },
      },
    }),
  );

  const rand = Math.random().toString(36).slice(2, 10);
  let counter = 0;

  afterAll(async () => {
    const users = await prisma.user.findMany({
      where: { email: { contains: rand } },
      select: { id: true },
    });
    await prisma.verification.deleteMany({
      where: { value: { in: users.map((user) => user.id) } },
    });
    // Audit rows cannot be deleted, so assertions filter by this run's users.
    await prisma.user.deleteMany({ where: { email: { contains: rand } } });
    await prisma.$disconnect();
  });

  async function settle() {
    await Promise.all(background.splice(0));
  }

  async function user({
    status = "ACTIVE",
    password,
  }: {
    status?: "ACTIVE" | "DEACTIVATED";
    password?: string;
  } = {}) {
    const email = `t19-${counter++}-${rand}@northeastern.edu`;
    const row = await prisma.user.create({
      data: { email, name: "Reset Test", emailVerified: true, status },
    });
    await prisma.account.create({
      data: {
        userId: row.id,
        accountId: row.id,
        providerId: "credential",
        password: password ?? (await hashPassword(OLD)),
      },
    });
    return { email, user: row };
  }

  async function requestReset(email: string) {
    const body = await auth.api.requestPasswordReset({ body: { email } });
    await settle();
    return body;
  }

  const resetEmails = (email: string) =>
    mailer.to(email).filter((message) => message.template === "reset-password");

  function tokenOf(email: string) {
    const message = resetEmails(email).at(-1);
    const token = new URL(String(message?.data.url)).searchParams.get("token");
    if (!token) throw new Error("no token in the emailed link");
    return token;
  }

  const reset = (token: string, newPassword = NEW) =>
    auth.api.resetPassword({ body: { token, newPassword } });

  const errorOf = (promise: Promise<unknown>) =>
    promise.then(
      () => null,
      (e: unknown) => e,
    );

  const events = (userId: string, type: string) =>
    prisma.auditEvent.findMany({
      where: { type, OR: [{ targetId: userId }, { actorUserId: userId }] },
    });

  async function addSession(userId: string) {
    return prisma.session.create({
      data: {
        userId,
        token: `t19-${counter++}-${rand}`,
        expiresAt: new Date(Date.now() + HOUR_MS),
      },
    });
  }

  async function signIn(email: string, password: string) {
    return errorOf(auth.api.signInEmail({ body: { email, password } }));
  }

  describe("the request", () => {
    it("answers an unknown and an existing address alike, and mails only the existing one", async () => {
      const known = await user();
      const unknown = `t19-none-${rand}@northeastern.edu`;

      const knownBody = await requestReset(known.email);
      const unknownBody = await requestReset(unknown);

      expect(unknownBody).toEqual(knownBody);
      expect(resetEmails(known.email)).toHaveLength(1);
      expect(resetEmails(unknown)).toHaveLength(0);
    });

    // Both paths do the same work before the response: a user lookup, then one
    // verification-table statement (an insert for a known address, Better Auth's
    // dummy lookup for an unknown one). The audit write and the mail run after
    // it. What remains is per-request jitter of the remote database, a few tens
    // of ms per round trip against Neon, so one median of a few samples can
    // exceed 50 ms by chance (red-team B17). Many samples, alternating which
    // address goes first, make the medians stable enough for the 50 ms bound to
    // test the property rather than the network.
    it("keeps the response time of both within 50 ms", async () => {
      const known = await user();
      const unknown = `t19-none-${rand}@northeastern.edu`;
      const time = async (email: string) => {
        const start = performance.now();
        await auth.api.requestPasswordReset({ body: { email } });
        const elapsed = performance.now() - start;
        await settle();
        return elapsed;
      };
      const median = (values: number[]) =>
        [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];

      for (let i = 0; i < 4; i++) {
        await time(known.email);
        await time(unknown);
      }
      const knownTimes: number[] = [];
      const unknownTimes: number[] = [];
      for (let i = 0; i < 30; i++) {
        if (i % 2 === 0) {
          knownTimes.push(await time(known.email));
          unknownTimes.push(await time(unknown));
        } else {
          unknownTimes.push(await time(unknown));
          knownTimes.push(await time(known.email));
        }
      }
      expect(Math.abs(median(knownTimes) - median(unknownTimes))).toBeLessThan(
        50,
      );
    }, 60_000);

    it("answers a deactivated address the same and mails nothing", async () => {
      const deactivated = await user({ status: "DEACTIVATED" });
      const known = await user();

      const body = await requestReset(deactivated.email);

      expect(body).toEqual(await requestReset(known.email));
      expect(resetEmails(deactivated.email)).toHaveLength(0);
    });

    it("links to the page on this origin", async () => {
      const { email } = await user();
      await requestReset(email);
      const link = new URL(String(resetEmails(email)[0].data.url));
      expect(link.origin + link.pathname).toBe(`${BASE_URL}/reset-password`);
      expect([...link.searchParams.keys()]).toEqual(["token"]);
      expect(resetEmails(email)[0].data.expiresInMinutes).toBe(60);
    });

    it("audits the request for an existing user only", async () => {
      const known = await user();
      await requestReset(known.email);
      expect(
        await events(known.user.id, "PASSWORD_RESET_REQUESTED"),
      ).toHaveLength(1);
    });
  });

  describe("storage", () => {
    it("stores only the hash of the token", async () => {
      const { email, user: row } = await user();
      await requestReset(email);
      const token = tokenOf(email);

      const rows = await prisma.verification.findMany({
        where: { value: row.id },
      });
      expect(rows).toHaveLength(1);
      // The parity check against Better Auth's own hasher.
      expect(rows[0].identifier).toBe(resetTokenStoredIdentifier(token));
      expect(rows[0].identifier).not.toContain(token);
      expect(rows[0].identifier.startsWith("reset-password:")).toBe(false);
      expect(
        Math.abs(rows[0].expiresAt.getTime() - (Date.now() + HOUR_MS)),
      ).toBeLessThan(60_000);
    });

    it("does not accept the stored hash as a token", async () => {
      const { email } = await user();
      await requestReset(email);
      const stored = resetTokenStoredIdentifier(tokenOf(email));
      expect(await errorOf(reset(stored))).toMatchObject({
        body: { code: "INVALID_TOKEN" },
      });
    });
  });

  describe("the page's peek", () => {
    it("reads without consuming, and rejects unknown and expired tokens", async () => {
      const { email, user: row } = await user();
      await requestReset(email);
      const token = tokenOf(email);

      expect(await isResetTokenUsable(prisma, token)).toBe(true);
      expect(await isResetTokenUsable(prisma, token)).toBe(true);
      expect(
        await prisma.verification.count({ where: { value: row.id } }),
      ).toBe(1);

      expect(await isResetTokenUsable(prisma, "not-a-token")).toBe(false);

      await prisma.verification.updateMany({
        where: { value: row.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await isResetTokenUsable(prisma, token)).toBe(false);
      expect(
        await prisma.verification.count({ where: { value: row.id } }),
      ).toBe(1);
    });
  });

  describe("the reset", () => {
    it("is single use", async () => {
      const { email, user: row } = await user();
      await requestReset(email);
      const token = tokenOf(email);

      expect(await reset(token)).toEqual({ status: true });
      expect(
        await prisma.verification.count({ where: { value: row.id } }),
      ).toBe(0);
      expect(
        await errorOf(reset(token, "another-new-password-2")),
      ).toMatchObject({
        body: { code: "INVALID_TOKEN" },
      });
      expect(await signIn(email, "another-new-password-2")).not.toBeNull();
    });

    it("refuses an expired token", async () => {
      const { email, user: row } = await user();
      await requestReset(email);
      await prisma.verification.updateMany({
        where: { value: row.id },
        data: { expiresAt: new Date(Date.now() - 1000) },
      });
      expect(await errorOf(reset(tokenOf(email)))).toMatchObject({
        body: { code: "INVALID_TOKEN" },
      });
    });

    it("refuses a password outside 12 to 128 characters", async () => {
      const { email } = await user();
      await requestReset(email);
      const token = tokenOf(email);
      expect(await errorOf(reset(token, "short"))).toMatchObject({
        body: { code: "PASSWORD_TOO_SHORT" },
      });
      // The token is still usable after a refused password.
      expect(await reset(token)).toEqual({ status: true });
    });

    it("revokes every session, so old cookies are rejected, and signs in with the new password only", async () => {
      const { email, user: row } = await user();
      await addSession(row.id);
      await addSession(row.id);
      await requestReset(email);

      await reset(tokenOf(email));

      expect(await prisma.session.count({ where: { userId: row.id } })).toBe(0);
      expect(await signIn(email, OLD)).toMatchObject({
        body: { code: "INVALID_EMAIL_OR_PASSWORD" },
      });
      expect(await signIn(email, NEW)).toBeNull();
    });

    it("stamps passwordChangedAt, audits, and sends the security notice", async () => {
      const { email, user: row } = await user();
      await requestReset(email);
      const token = tokenOf(email);
      mailer.clear();

      await reset(token);

      const after = await prisma.user.findUniqueOrThrow({
        where: { id: row.id },
      });
      expect(after.passwordChangedAt).not.toBeNull();
      const audited = await events(row.id, "PASSWORD_RESET");
      expect(audited).toHaveLength(1);
      expect(JSON.stringify(audited[0].metadata ?? {})).not.toContain(token);
      expect(JSON.stringify(audited[0].metadata ?? {})).not.toContain(
        resetTokenStoredIdentifier(token),
      );
      expect(await events(row.id, "ACCOUNT_UNLOCKED")).toHaveLength(0);

      const notices = mailer
        .to(email)
        .filter((message) => message.template === "security-notice");
      expect(notices).toHaveLength(1);
      expect(notices[0].data).toMatchObject({ event: "password-reset" });
    });

    it("clears a live lock and retires its unlock link", async () => {
      const { email, user: row } = await user();
      await prisma.accountLock.create({
        data: {
          userId: row.id,
          failedCount: 5,
          lockedUntil: new Date(Date.now() + HOUR_MS),
          lockLevel: 1,
        },
      });
      const unlock = await prisma.unlockToken.create({
        data: {
          userId: row.id,
          tokenHash: createHash("sha256")
            .update(`t19-${rand}-${counter++}`)
            .digest("hex"),
          expiresAt: new Date(Date.now() + HOUR_MS),
        },
      });
      await requestReset(email);

      await reset(tokenOf(email));

      expect(await events(row.id, "ACCOUNT_UNLOCKED")).toHaveLength(1);
      expect(
        (
          await prisma.unlockToken.findUniqueOrThrow({
            where: { id: unlock.id },
          })
        ).usedAt,
      ).not.toBeNull();
      expect(await signIn(email, NEW)).toBeNull();
    });

    it("moves an imported bcrypt account to scrypt", async () => {
      const { email, user: row } = await user({
        password: LEGACY_BCRYPT_PREFIX + bcrypt.hashSync(OLD, 4),
      });
      await requestReset(email);

      await reset(tokenOf(email));

      const account = await prisma.account.findFirstOrThrow({
        where: { userId: row.id, providerId: "credential" },
      });
      expect(account.password).not.toMatch(/^bcrypt\$/);
      expect(await signIn(email, NEW)).toBeNull();
    });
  });
});
