import { randomInt } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { runSecurityAlerts } from "@/lib/alerts/run";
import { COOLDOWN_MS } from "@/lib/alerts/rules";
import type { Mailer } from "@/lib/email/mailer";
import { prisma } from "@/lib/prisma";
import { createAdmin, createUser } from "@/test/factories";
import { createCapturingMailer } from "@/test/capturing-mailer";

const MINUTE_MS = 60_000;

// AuditEvent is append-only, so rows from earlier runs stay. Each test counts
// in its own fixed instant, a random day between 2001 and 2020, so no real row
// and no other test's row falls in any window.
function randomNow(): Date {
  const start = Date.UTC(2001, 0, 1);
  const days = randomInt(0, 365 * 19);
  return new Date(start + days * 24 * 60 * MINUTE_MS + 12 * 60 * MINUTE_MS);
}

const at = (now: Date, minutes: number) =>
  new Date(now.getTime() + minutes * MINUTE_MS);

async function auditRows(
  type: string,
  count: number,
  createdAt: Date,
  actor: { actorType: "SYSTEM" | "BREAK_GLASS" } = { actorType: "SYSTEM" },
) {
  await prisma.auditEvent.createMany({
    data: Array.from({ length: count }, () => ({
      type,
      actorType: actor.actorType,
      ip: null,
      createdAt,
    })),
  });
}

function loginFailures(count: number, now: Date) {
  // Inside the 15 minutes before `now`.
  return auditRows("LOGIN_FAILED", count, at(now, -5));
}

function setup(mailer: Mailer = createCapturingMailer()) {
  const log = { info: vi.fn(), error: vi.fn() };
  const run = (now: Date) =>
    runSecurityAlerts({ db: prisma, mailer, log, now });
  return { mailer, log, run };
}

describe("runSecurityAlerts", () => {
  let first: Awaited<ReturnType<typeof createAdmin>>;
  let second: Awaited<ReturnType<typeof createAdmin>>;

  beforeEach(async () => {
    await prisma.alertState.deleteMany();
    await prisma.opsSignal.deleteMany();
    await prisma.user.deleteMany({ where: { isPrimaryAdmin: false } });
    first = await createAdmin();
    second = await createAdmin();
    await createAdmin({ status: "DEACTIVATED" });
    await createUser();
  });

  it("sends exactly one email per admin for a spike, stays quiet during the cooldown, and sends again an hour later", async () => {
    const now = randomNow();
    const capture = createCapturingMailer();
    const { run } = setup(capture);
    await loginFailures(51, now);

    const initial = await run(now);
    expect(initial.fired).toEqual(["login-failed-spike"]);
    expect(capture.sent).toHaveLength(2);
    expect(capture.to(first.email)).toHaveLength(1);
    expect(capture.to(second.email)).toHaveLength(1);
    expect(capture.sent[0]).toMatchObject({
      template: "security-alert",
      data: { items: [{ rule: "login-failed-spike", count: 51 }] },
    });

    // The spike keeps going at each later check.
    for (const minutes of [15, 30, 45]) {
      await auditRows("LOGIN_FAILED", 51, at(now, minutes - 5));
      const result = await run(at(now, minutes));
      expect(result.fired).toEqual([]);
      expect(result.suppressed).toContain("login-failed-spike");
    }
    expect(capture.sent).toHaveLength(2);

    await auditRows("LOGIN_FAILED", 51, at(now, 55));
    const later = await run(at(now, 60));
    expect(later.fired).toEqual(["login-failed-spike"]);
    expect(capture.sent).toHaveLength(4);
  });

  it("does not fire a spike at its threshold", async () => {
    const now = randomNow();
    const capture = createCapturingMailer();
    const { run } = setup(capture);
    await loginFailures(50, now);

    const result = await run(now);
    expect(result.fired).toEqual([]);
    expect(capture.sent).toHaveLength(0);
  });

  it("sends one set of emails when two runs overlap", async () => {
    const now = randomNow();
    const capture = createCapturingMailer();
    const { run } = setup(capture);
    await loginFailures(51, now);

    const results = await Promise.all([run(now), run(now)]);
    expect(results.flatMap((r) => r.fired)).toEqual(["login-failed-spike"]);
    expect(capture.sent).toHaveLength(2);
  });

  it("reports an any rule once, then only what is new after the cooldown", async () => {
    const now = randomNow();
    const capture = createCapturingMailer();
    const { run } = setup(capture);
    await auditRows("BREAK_GLASS_PA_RECOVERY", 1, at(now, -2), {
      actorType: "BREAK_GLASS",
    });

    expect((await run(now)).fired).toEqual(["break-glass"]);
    expect(capture.sent).toHaveLength(2);

    await auditRows("BREAK_GLASS_PA_RECOVERY", 1, at(now, 10), {
      actorType: "BREAK_GLASS",
    });
    expect((await run(at(now, 30))).fired).toEqual([]);
    expect(capture.sent).toHaveLength(2);

    capture.clear();
    const after = await run(at(now, 60));
    expect(after.fired).toEqual(["break-glass"]);
    expect(capture.sent[0]).toMatchObject({
      data: { items: [{ rule: "break-glass", count: 1 }] },
    });
  });

  it("combines every claimed rule into one email per admin", async () => {
    const now = randomNow();
    const capture = createCapturingMailer();
    const { run } = setup(capture);
    await loginFailures(51, now);
    await auditRows("JWKS_ROTATED", 1, at(now, -3));

    const result = await run(now);
    expect([...result.fired].sort()).toEqual([
      "jwks-rotated",
      "login-failed-spike",
    ]);
    expect(capture.sent).toHaveLength(2);
  });

  it("releases the claim and throws when no send succeeds, then sends once the mailer works", async () => {
    const now = randomNow();
    await loginFailures(51, now);
    const failing: Mailer = { sendEmail: async () => ({ status: "failed" }) };
    const broken = setup(failing);

    await expect(broken.run(now)).rejects.toThrow(
      "security alert not delivered",
    );
    expect(await prisma.alertState.count()).toBe(0);
    expect(broken.log.error).toHaveBeenCalledWith(
      "[ALERT] security alert not delivered",
      { rules: ["login-failed-spike"], reason: "send-failed" },
    );

    const capture = createCapturingMailer();
    const working = setup(capture);
    expect((await working.run(at(now, 1))).fired).toEqual([
      "login-failed-spike",
    ]);
    expect(capture.sent).toHaveLength(2);
  });

  it("restores the previous state on release", async () => {
    const now = randomNow();
    const previous = at(now, -(COOLDOWN_MS / MINUTE_MS) - 30);
    await prisma.alertState.create({
      data: {
        ruleKey: "login-failed-spike",
        lastSentAt: previous,
        coveredThrough: previous,
      },
    });
    await loginFailures(51, now);
    const failing: Mailer = { sendEmail: async () => ({ status: "failed" }) };

    await expect(setup(failing).run(now)).rejects.toThrow();
    const row = await prisma.alertState.findUniqueOrThrow({
      where: { ruleKey: "login-failed-spike" },
    });
    expect(row.lastSentAt).toEqual(previous);
    expect(row.coveredThrough).toEqual(previous);
  });

  it("keeps the claim when only some sends fail", async () => {
    const now = randomNow();
    await loginFailures(51, now);
    let calls = 0;
    const flaky: Mailer = {
      sendEmail: async () => {
        calls += 1;
        return calls === 1 ? { status: "sent" } : { status: "failed" };
      },
    };

    const result = await setup(flaky).run(now);
    expect(result).toMatchObject({ sent: 1, failed: 1 });
    expect(await prisma.alertState.count()).toBe(1);
  });

  it("keeps the claim when the mailer throws after an admin was emailed", async () => {
    const now = randomNow();
    await loginFailures(51, now);
    let calls = 0;
    const throwing: Mailer = {
      sendEmail: async () => {
        calls += 1;
        if (calls === 1) return { status: "sent" };
        throw new Error("mailer crashed");
      },
    };

    await expect(setup(throwing).run(now)).rejects.toThrow("mailer crashed");
    expect(await prisma.alertState.count()).toBe(1);
  });

  it("releases the claim when the mailer throws before any admin was emailed", async () => {
    const now = randomNow();
    await loginFailures(51, now);
    const throwing: Mailer = {
      sendEmail: async () => {
        throw new Error("mailer crashed");
      },
    };

    await expect(setup(throwing).run(now)).rejects.toThrow("mailer crashed");
    expect(await prisma.alertState.count()).toBe(0);
  });

  it("throws and leaves the state unclaimed when there are no admins", async () => {
    const now = randomNow();
    await prisma.user.deleteMany({ where: { isPrimaryAdmin: false } });
    await loginFailures(51, now);
    const { run, log } = setup();

    await expect(run(now)).rejects.toThrow("security alert not delivered");
    expect(await prisma.alertState.count()).toBe(0);
    expect(log.error).toHaveBeenCalledWith(
      "[ALERT] security alert not delivered",
      { rules: ["login-failed-spike"], reason: "no-recipients" },
    );
  });

  it("alerts on operational signals and lists the failed job", async () => {
    const now = randomNow();
    const capture = createCapturingMailer();
    const { run } = setup(capture);
    await prisma.opsSignal.createMany({
      data: [
        {
          kind: "JOB_FAILED",
          detail: { job: "pa-transfer" },
          createdAt: at(now, -4),
        },
        {
          kind: "RATE_LIMIT_FAIL_OPEN",
          detail: { policy: "signIn", rule: "ip", reason: "timeout" },
          createdAt: at(now, -3),
        },
      ],
    });

    const result = await run(now);
    expect([...result.fired].sort()).toEqual([
      "job-failed",
      "upstash-fail-open",
    ]);
    const items = (
      capture.sent[0].data as { items: { rule: string; jobs?: string[] }[] }
    ).items;
    expect(items.find((item) => item.rule === "job-failed")?.jobs).toEqual([
      "pa-transfer",
    ]);
  });
});
