import { randomBytes } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { writeAuditEvent } from "@/lib/audit";
import type { Mailer } from "@/lib/email/mailer";
import { prisma } from "@/lib/prisma";
import { runRetention, type RetentionReport } from "@/lib/retention/job";
import { ensureHarnessPrimaryAdmin } from "@/test/harness-primary-admin";
import { createCapturingMailer } from "@/test/capturing-mailer";
import {
  createAdmin,
  createPosition,
  createSession,
  createUser,
} from "@/test/factories";

// Time travel without a fake clock: `runRetention` takes `now`, so each case
// creates rows relative to BASE and runs the job at BASE plus N days. Rows keep
// their real `createdAt` unless a case sets one, so a case that depends on age
// sets it. The job sweeps the whole table, so a case asserts on its own rows
// and never on a global count (the db project resets tables once per file).

const DAY_MS = 24 * 60 * 60 * 1000;
const BASE = new Date();
const at = (days: number) => new Date(BASE.getTime() + days * DAY_MS);

const mailer = createCapturingMailer();
const log = { warn: vi.fn(), error: vi.fn() };

function run(
  days: number,
  {
    dryRun = false,
    via = mailer,
  }: { dryRun?: boolean; via?: Pick<Mailer, "sendEmail"> } = {},
) {
  return runRetention({
    db: prisma,
    mailer: via,
    signInUrl: "https://auth.example.test/sign-in",
    now: at(days),
    dryRun,
    log,
  });
}

const deletedRows = (userId: string) =>
  prisma.auditEvent.findMany({
    where: { targetType: "USER", targetId: userId, type: "USER_DELETED" },
  });

const statusOf = async (userId: string) =>
  (await prisma.user.findUniqueOrThrow({ where: { id: userId } })).status;

const hexHash = () => randomBytes(32).toString("hex");

async function selfSignUp(overrides: Parameters<typeof createUser>[0] = {}) {
  const user = await createUser({
    emailVerified: false,
    createdAt: BASE,
    ...overrides,
  });
  await writeAuditEvent(prisma, {
    type: "USER_CREATED",
    actorType: "USER",
    actorUserId: user.id,
    targetType: "USER",
    targetId: user.id,
    metadata: { source: "self_signup" },
  });
  return user;
}

function normalized(report: RetentionReport) {
  return {
    ...report,
    dryRun: false,
    exempt: [...report.exempt].sort((a, b) =>
      `${a.userId}${a.rule}`.localeCompare(`${b.userId}${b.rule}`),
    ),
  };
}

describe("runRetention", () => {
  beforeAll(() => {
    mailer.clear();
  });

  describe("deactivated users (30 days)", () => {
    it("tombstones at 30 days, not before, with one USER_DELETED row", async () => {
      const user = await createUser({
        status: "DEACTIVATED",
        deactivatedAt: BASE,
      });
      const position = await createPosition();
      await prisma.userPosition.create({
        data: { userId: user.id, positionId: position.id },
      });

      await run(29);
      expect(await statusOf(user.id)).toBe("DEACTIVATED");
      expect(await deletedRows(user.id)).toHaveLength(0);

      const report = await run(30);
      expect(report.tombstoned.deactivated).toBeGreaterThanOrEqual(1);
      expect(await statusOf(user.id)).toBe("DELETED");
      const rows = await deletedRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        actorType: "SYSTEM",
        actorUserId: null,
        ip: null,
        userAgent: null,
        metadata: {
          reason: "deactivated_30d",
          removedPositionIds: [position.id],
        },
      });
    });

    it("never tombstones a deactivated admin and lists it for review", async () => {
      const admin = await createAdmin({
        status: "DEACTIVATED",
        deactivatedAt: BASE,
      });
      const report = await run(31);
      expect(await statusOf(admin.id)).toBe("DEACTIVATED");
      expect(report.exempt).toContainEqual({
        userId: admin.id,
        rule: "deactivated",
      });
      expect(log.warn).toHaveBeenCalledWith(
        "retention_exempt",
        expect.objectContaining({ rule: "deactivated" }),
      );
    });
  });

  describe("inactivity (11 and 12 months)", () => {
    it("notices at 335 days, once, and tombstones at 365", async () => {
      const user = await createUser({ lastLoginAt: BASE });

      await run(334);
      expect(mailer.to(user.email)).toHaveLength(0);

      await run(335);
      expect(mailer.to(user.email)).toHaveLength(1);
      expect(mailer.to(user.email)[0]).toMatchObject({
        template: "inactivity-notice",
        data: {
          lastLoginAt: BASE,
          deactivateAfter: at(365),
          signInUrl: "https://auth.example.test/sign-in",
        },
      });
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .inactivityNoticeSentAt,
      ).toEqual(at(335));

      await run(335);
      expect(mailer.to(user.email)).toHaveLength(1);

      await run(364);
      expect(await statusOf(user.id)).toBe("ACTIVE");

      await run(365);
      expect(await statusOf(user.id)).toBe("DELETED");
      const rows = await deletedRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ reason: "inactive_12mo" });
    });

    it("ages a user who never signed in from creation", async () => {
      const user = await createUser({ lastLoginAt: null, createdAt: BASE });
      await run(334);
      expect(mailer.to(user.email)).toHaveLength(0);
      await run(335);
      expect(mailer.to(user.email)).toHaveLength(1);
      expect(mailer.to(user.email)[0].data).toMatchObject({
        lastLoginAt: BASE,
      });
    });

    it("lets a sign-in after the notice supersede it", async () => {
      const user = await createUser({ lastLoginAt: BASE });
      await run(335);
      expect(mailer.to(user.email)).toHaveLength(1);

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: at(340) },
      });
      await run(365);
      expect(await statusOf(user.id)).toBe("ACTIVE");

      await run(340 + 335);
      expect(mailer.to(user.email)).toHaveLength(2);
    });

    it("gives a user first seen late the full 30 days after the notice", async () => {
      const user = await createUser({ lastLoginAt: BASE });

      await run(400);
      expect(mailer.to(user.email)).toHaveLength(1);
      expect(mailer.to(user.email)[0].data).toMatchObject({
        deactivateAfter: at(430),
      });
      expect(await statusOf(user.id)).toBe("ACTIVE");

      await run(429);
      expect(await statusOf(user.id)).toBe("ACTIVE");
      await run(430);
      expect(await statusOf(user.id)).toBe("DELETED");
    });

    it("keeps a capped notice unrecorded and retries it", async () => {
      const user = await createUser({ lastLoginAt: BASE });
      const capped: Pick<Mailer, "sendEmail"> = {
        sendEmail: async () => ({ status: "capped", cap: "global:1d" }),
      };

      const first = await run(335, { via: capped });
      expect(first.notices.capped).toBeGreaterThanOrEqual(1);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .inactivityNoticeSentAt,
      ).toBeNull();

      await run(336);
      expect(mailer.to(user.email)).toHaveLength(1);
    });

    it("exempts admins and the Primary Admin, but not a position holder", async () => {
      const admin = await createAdmin({ lastLoginAt: BASE });
      const primary = await ensureHarnessPrimaryAdmin({
        password: "correct-horse-battery-staple",
      });
      await prisma.user.update({
        where: { id: primary.id },
        data: { lastLoginAt: BASE },
      });
      const holder = await createUser({ lastLoginAt: BASE });
      const position = await createPosition();
      await prisma.userPosition.create({
        data: { userId: holder.id, positionId: position.id },
      });

      await run(335);
      const report = await run(365);

      expect(await statusOf(admin.id)).toBe("ACTIVE");
      expect(await statusOf(primary.id)).toBe("ACTIVE");
      expect(mailer.to(admin.email)).toHaveLength(0);
      expect(mailer.to(primary.email)).toHaveLength(0);
      expect(report.exempt).toEqual(
        expect.arrayContaining([
          { userId: admin.id, rule: "inactive" },
          { userId: primary.id, rule: "inactive" },
        ]),
      );

      expect(await statusOf(holder.id)).toBe("DELETED");
      const rows = await deletedRows(holder.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toEqual({
        reason: "inactive_12mo",
        removedPositionIds: [position.id],
      });
    });
  });

  describe("unverified sign-ups (7 days)", () => {
    it("tombstones an unverified self sign-up at 7 days, not before", async () => {
      const user = await selfSignUp();
      await run(6);
      expect(await statusOf(user.id)).toBe("ACTIVE");

      await run(7);
      expect(await statusOf(user.id)).toBe("DELETED");
      const rows = await deletedRows(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0].metadata).toMatchObject({ reason: "unverified_7d" });
    });

    it("leaves alone a user with no self sign-up audit row", async () => {
      const invited = await createUser({
        emailVerified: false,
        createdAt: BASE,
      });
      const imported = await createUser({
        emailVerified: false,
        createdAt: BASE,
      });
      await writeAuditEvent(prisma, {
        type: "USER_CREATED",
        actorType: "SYSTEM",
        targetType: "USER",
        targetId: imported.id,
        metadata: { source: "system" },
      });
      await run(8);
      expect(await statusOf(invited.id)).toBe("ACTIVE");
      expect(await statusOf(imported.id)).toBe("ACTIVE");
    });

    it("leaves alone a verified user and one who has signed in", async () => {
      const verified = await selfSignUp({ emailVerified: true });
      const signedIn = await selfSignUp({ lastLoginAt: at(1) });
      await run(8);
      expect(await statusOf(verified.id)).toBe("ACTIVE");
      expect(await statusOf(signedIn.id)).toBe("ACTIVE");
    });
  });

  describe("sessions, tokens and verifications", () => {
    it("purges a session past the 90-day cap even though it was refreshed", async () => {
      const user = await createUser();
      // The database clamps `expiresAt` to the cap, so a refresh cannot outlive
      // it; the rule is checked on `createdAt` either way.
      const old = await createSession(user, {
        createdAt: BASE,
        expiresAt: at(200),
        absoluteExpiresAt: at(200),
      });
      const fresh = await createSession(user, {
        createdAt: at(80),
        expiresAt: at(110),
        absoluteExpiresAt: at(170),
      });

      await run(91);
      expect(
        await prisma.session.findUnique({ where: { id: old.id } }),
      ).toBeNull();
      expect(
        await prisma.session.findUnique({ where: { id: fresh.id } }),
      ).not.toBeNull();
    });

    it("purges an expired session and keeps a live one", async () => {
      const user = await createUser();
      const expired = await createSession(user, { expiresAt: at(5) });
      const live = await createSession(user);

      await run(6);
      expect(
        await prisma.session.findUnique({ where: { id: expired.id } }),
      ).toBeNull();
      expect(
        await prisma.session.findUnique({ where: { id: live.id } }),
      ).not.toBeNull();
    });

    it("purges expired verifications and unlock tokens only", async () => {
      const user = await createUser();
      const verifications = await Promise.all(
        [at(5), at(20)].map((expiresAt) =>
          prisma.verification.create({
            data: { identifier: "retention-test", value: "v", expiresAt },
          }),
        ),
      );
      const tokens = await Promise.all(
        [at(5), at(20)].map((expiresAt) =>
          prisma.unlockToken.create({
            data: { userId: user.id, tokenHash: hexHash(), expiresAt },
          }),
        ),
      );

      await run(10);
      const remainingVerifications = await prisma.verification.findMany({
        where: { id: { in: verifications.map((v) => v.id) } },
      });
      expect(remainingVerifications.map((v) => v.id)).toEqual([
        verifications[1].id,
      ]);
      const remainingTokens = await prisma.unlockToken.findMany({
        where: { id: { in: tokens.map((t) => t.id) } },
      });
      expect(remainingTokens.map((t) => t.id)).toEqual([tokens[1].id]);
    });
  });

  describe("audit IP and user agent (90 days)", () => {
    it("nulls them past 90 days and keeps the rest of the row", async () => {
      const user = await createUser();
      const row = (createdAt: Date) =>
        prisma.auditEvent.create({
          data: {
            type: "LOGIN_SUCCESS",
            actorType: "USER",
            actorUserId: user.id,
            targetType: "USER",
            targetId: user.id,
            metadata: { method: "password" },
            ip: "203.0.113.7",
            userAgent: "test-browser",
            createdAt,
          },
        });
      const old = await row(at(-91));
      const recent = await row(at(-89));

      await run(0);

      expect(
        await prisma.auditEvent.findUniqueOrThrow({ where: { id: old.id } }),
      ).toMatchObject({
        type: "LOGIN_SUCCESS",
        actorUserId: user.id,
        metadata: { method: "password" },
        ip: null,
        userAgent: null,
      });
      expect(
        await prisma.auditEvent.findUniqueOrThrow({
          where: { id: recent.id },
        }),
      ).toMatchObject({ ip: "203.0.113.7", userAgent: "test-browser" });
    });
  });

  describe("a failing step", () => {
    it("is counted and does not stop the steps after it", async () => {
      const user = await createUser({ lastLoginAt: BASE });
      const expired = await createSession(await createUser(), {
        expiresAt: at(5),
      });
      const throwing: Pick<Mailer, "sendEmail"> = {
        sendEmail: async () => {
          throw new Error("template rejected the data");
        },
      };

      const report = await run(335, { via: throwing });

      expect(report.errors).toBeGreaterThanOrEqual(1);
      expect(report.notices.failed).toBeGreaterThanOrEqual(1);
      expect(log.error).toHaveBeenCalledWith(
        "retention_step_failed",
        expect.objectContaining({
          step: "inactive-notice",
          errorName: "Error",
        }),
      );
      expect(
        await prisma.session.findUnique({ where: { id: expired.id } }),
      ).toBeNull();
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: user.id } }))
          .inactivityNoticeSentAt,
      ).toBeNull();
    });
  });

  describe("a dry run", () => {
    it("reports what a real run then does, and writes nothing", async () => {
      const deactivated = await createUser({
        status: "DEACTIVATED",
        deactivatedAt: BASE,
      });
      const noticeDue = await createUser({ lastLoginAt: at(-310) });
      const user = await createUser();
      const expired = await createSession(user, { expiresAt: at(5) });
      const sent = mailer.sent.length;
      const events = await prisma.auditEvent.count({
        where: { targetId: deactivated.id },
      });

      const dry = await run(31, { dryRun: true });

      expect(dry.dryRun).toBe(true);
      expect(await statusOf(deactivated.id)).toBe("DEACTIVATED");
      expect(
        await prisma.session.findUnique({ where: { id: expired.id } }),
      ).not.toBeNull();
      expect(mailer.sent).toHaveLength(sent);
      expect(
        await prisma.auditEvent.count({ where: { targetId: deactivated.id } }),
      ).toBe(events);
      expect(
        (await prisma.user.findUniqueOrThrow({ where: { id: noticeDue.id } }))
          .inactivityNoticeSentAt,
      ).toBeNull();
      expect(dry.tombstoned.deactivated).toBeGreaterThanOrEqual(1);
      expect(dry.notices.sent).toBeGreaterThanOrEqual(1);
      expect(dry.purged.sessions).toBeGreaterThanOrEqual(1);

      const real = await run(31);
      expect(normalized(real)).toEqual(normalized(dry));
      expect(await statusOf(deactivated.id)).toBe("DELETED");
      expect(mailer.to(noticeDue.email)).toHaveLength(1);
    });

    it("is followed by a real run with nothing left to do", async () => {
      const again = await run(31);
      expect(again.tombstoned).toEqual({
        deactivated: 0,
        inactive: 0,
        unverified: 0,
      });
      expect(again.notices.sent).toBe(0);
      expect(again.purged).toEqual({
        sessions: 0,
        verifications: 0,
        unlockTokens: 0,
      });
      expect(again.anonymizedAuditRows).toBe(0);
      expect(again.errors).toBe(0);
    });
  });

  describe("the batch cap", () => {
    it(
      "tombstones 50 a run and leaves the rest for the next",
      { timeout: 60_000 },
      async () => {
        // Drain anything an earlier case left, so the count below is this case's.
        await run(31);
        await prisma.user.createMany({
          data: Array.from({ length: 51 }, (_, i) => ({
            email: `batch-${i}-${randomBytes(4).toString("hex")}@northeastern.edu`,
            name: `Batch ${i}`,
            status: "DEACTIVATED" as const,
            deactivatedAt: BASE,
          })),
        });

        const first = await run(31);
        expect(first.tombstoned.deactivated).toBe(50);
        expect(first.deferred.tombstones).toBe(1);

        const second = await run(31);
        expect(second.tombstoned.deactivated).toBe(1);
        expect(second.deferred.tombstones).toBe(0);
      },
    );
  });
});
