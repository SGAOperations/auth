import { afterEach, describe, expect, it } from "vitest";
import { createCapturingMailer } from "./capturing-mailer";
import { createFakeRateLimiter } from "./fake-rate-limiter";
import { useFakeClock } from "./fake-clock";

const MINUTE_MS = 60_000;

describe("useFakeClock", () => {
  const clocks: { restore(): void }[] = [];
  afterEach(() => {
    clocks.splice(0).forEach((clock) => clock.restore());
  });

  it("starts at the given time and advances Date.now()", () => {
    const clock = useFakeClock("2026-03-01T00:00:00Z");
    clocks.push(clock);
    expect(Date.now()).toBe(Date.parse("2026-03-01T00:00:00Z"));

    clock.advance(MINUTE_MS);
    expect(Date.now()).toBe(Date.parse("2026-03-01T00:01:00Z"));
    expect(clock.now().toISOString()).toBe("2026-03-01T00:01:00.000Z");
  });

  it("set jumps to an absolute time", () => {
    const clock = useFakeClock();
    clocks.push(clock);
    clock.set("2027-06-15T12:00:00Z");
    expect(Date.now()).toBe(Date.parse("2027-06-15T12:00:00Z"));
  });

  it("restore returns to real time", () => {
    const clock = useFakeClock("2000-01-01T00:00:00Z");
    clock.restore();
    expect(Date.now()).toBeGreaterThan(Date.parse("2025-01-01T00:00:00Z"));
  });
});

describe("createCapturingMailer", () => {
  it("captures messages in order", async () => {
    const mailer = createCapturingMailer();
    await mailer.sendEmail({
      to: "a@northeastern.edu",
      template: "welcome",
      data: { name: "A" },
    });
    await mailer.sendEmail({
      to: "b@northeastern.edu",
      template: "reset",
      data: {},
    });
    expect(mailer.sent.map((m) => m.template)).toEqual(["welcome", "reset"]);
    expect(mailer.last()?.to).toBe("b@northeastern.edu");
  });

  it("filters by recipient case-insensitively", async () => {
    const mailer = createCapturingMailer();
    await mailer.sendEmail({
      to: "Alice@Northeastern.edu",
      template: "welcome",
      data: {},
    });
    expect(mailer.to("alice@northeastern.edu")).toHaveLength(1);
    expect(mailer.to("bob@northeastern.edu")).toHaveLength(0);
  });

  it("is not rewritten by later mutation of the message", async () => {
    const mailer = createCapturingMailer();
    const message = {
      to: "a@northeastern.edu",
      template: "welcome",
      data: { code: "111" },
    };
    await mailer.sendEmail(message);
    message.data.code = "999";
    expect(mailer.last()?.data).toEqual({ code: "111" });
  });

  it("clear empties the list", async () => {
    const mailer = createCapturingMailer();
    await mailer.sendEmail({
      to: "a@northeastern.edu",
      template: "welcome",
      data: {},
    });
    mailer.clear();
    expect(mailer.sent).toHaveLength(0);
    expect(mailer.last()).toBeUndefined();
  });
});

describe("createFakeRateLimiter", () => {
  const clocks: { restore(): void }[] = [];
  afterEach(() => {
    clocks.splice(0).forEach((clock) => clock.restore());
  });

  it("allows exactly `limit` calls, then reports the reset time", async () => {
    const clock = useFakeClock("2026-01-01T00:00:00Z");
    clocks.push(clock);
    const limiter = createFakeRateLimiter({ limit: 2, windowMs: MINUTE_MS });

    const first = await limiter.limit("ip-1");
    expect(first).toMatchObject({ success: true, limit: 2, remaining: 1 });
    clock.advance(10_000);
    const second = await limiter.limit("ip-1");
    expect(second).toMatchObject({ success: true, remaining: 0 });

    const blocked = await limiter.limit("ip-1");
    expect(blocked.success).toBe(false);
    expect(blocked.remaining).toBe(0);
    expect(blocked.reset).toBe(Date.parse("2026-01-01T00:01:00Z"));
    await expect(blocked.pending).resolves.toBeUndefined();
  });

  it("allows calls again once the window has passed", async () => {
    const clock = useFakeClock();
    clocks.push(clock);
    const limiter = createFakeRateLimiter({ limit: 1, windowMs: MINUTE_MS });

    await limiter.limit("ip-1");
    expect((await limiter.limit("ip-1")).success).toBe(false);
    clock.advance(MINUTE_MS);
    expect((await limiter.limit("ip-1")).success).toBe(true);
  });

  it("keeps identifiers independent and records calls", async () => {
    const limiter = createFakeRateLimiter({ limit: 1, windowMs: MINUTE_MS });
    expect((await limiter.limit("a")).success).toBe(true);
    expect((await limiter.limit("b")).success).toBe(true);
    expect((await limiter.limit("a")).success).toBe(false);
    expect(limiter.calls).toEqual(["a", "b", "a"]);
  });

  it("rejects while unavailable and recovers", async () => {
    const limiter = createFakeRateLimiter({ limit: 1, windowMs: MINUTE_MS });
    limiter.setUnavailable(true);
    await expect(limiter.limit("a")).rejects.toThrow(
      "fake Upstash unavailable",
    );
    limiter.setUnavailable(false);
    expect((await limiter.limit("a")).success).toBe(true);
  });

  it("resetAll clears hits and calls", async () => {
    const limiter = createFakeRateLimiter({ limit: 1, windowMs: MINUTE_MS });
    await limiter.limit("a");
    limiter.resetAll();
    expect(limiter.calls).toEqual([]);
    expect((await limiter.limit("a")).success).toBe(true);
  });
});
