import { describe, expect, it } from "vitest";
import {
  ALERT_RULES,
  ANY_LOOKBACK_CAP_MS,
  COOLDOWN_MS,
  cooldownPassed,
  shouldFire,
  windowStart,
  type AlertRule,
} from "@/lib/alerts/rules";

function rule(key: string): AlertRule {
  const found = ALERT_RULES.find((r) => r.key === key);
  if (!found) throw new Error(`no rule ${key}`);
  return found;
}

const NOW = new Date("2026-11-01T12:00:00Z");
const at = (msBefore: number) => new Date(NOW.getTime() - msBefore);

describe("ALERT_RULES", () => {
  it("has unique keys", () => {
    const keys = ALERT_RULES.map((r) => r.key);
    expect(new Set(keys).size).toBe(keys.length);
  });
});

describe("shouldFire", () => {
  it("fires a spike only above its threshold", () => {
    expect(shouldFire(rule("login-failed-spike"), 50)).toBe(false);
    expect(shouldFire(rule("login-failed-spike"), 51)).toBe(true);
    expect(shouldFire(rule("account-locked-spike"), 5)).toBe(false);
    expect(shouldFire(rule("account-locked-spike"), 6)).toBe(true);
  });

  it("fires an any rule at one", () => {
    expect(shouldFire(rule("break-glass"), 0)).toBe(false);
    expect(shouldFire(rule("break-glass"), 1)).toBe(true);
  });
});

describe("cooldownPassed", () => {
  it("is open when the rule never sent", () => {
    expect(cooldownPassed(null, NOW)).toBe(true);
  });

  it("blocks at 54:59 and passes at 55:00", () => {
    expect(cooldownPassed(at(COOLDOWN_MS - 1000), NOW)).toBe(false);
    expect(cooldownPassed(at(COOLDOWN_MS), NOW)).toBe(true);
  });
});

describe("windowStart", () => {
  it("looks back a spike's own window", () => {
    expect(windowStart(rule("login-failed-spike"), null, NOW)).toEqual(
      at(15 * 60_000),
    );
    expect(windowStart(rule("account-locked-spike"), at(1000), NOW)).toEqual(
      at(60 * 60_000),
    );
  });

  it("starts an any rule at what it last reported", () => {
    const covered = at(2 * 60 * 60_000);
    expect(windowStart(rule("break-glass"), covered, NOW)).toEqual(covered);
  });

  it("caps an any rule's lookback at 24 hours", () => {
    const floor = at(ANY_LOOKBACK_CAP_MS);
    expect(windowStart(rule("break-glass"), null, NOW)).toEqual(floor);
    expect(
      windowStart(rule("break-glass"), at(ANY_LOOKBACK_CAP_MS * 3), NOW),
    ).toEqual(floor);
  });
});
