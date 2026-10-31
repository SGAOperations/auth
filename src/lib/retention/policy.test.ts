import { describe, expect, it } from "vitest";
import { SESSION_ABSOLUTE_MAX_AGE_MS } from "@/lib/auth/session-lifetime";
import {
  cutoffs,
  deactivatedTombstoneAt,
  inactivityDeadline,
  inactivityNoticeDue,
  inactivityReference,
  noticeIsCurrent,
  tombstoneEmail,
} from "@/lib/retention/policy";

const DAY_MS = 24 * 60 * 60 * 1000;
const NOW = new Date("2026-06-15T08:23:00Z");
const daysAgo = (days: number) => new Date(NOW.getTime() - days * DAY_MS);
const daysAfter = (date: Date, days: number) =>
  new Date(date.getTime() + days * DAY_MS);

describe("cutoffs", () => {
  it("is each threshold before now", () => {
    expect(cutoffs(NOW)).toEqual({
      deactivatedBefore: daysAgo(30),
      noticeBefore: daysAgo(335),
      inactiveBefore: daysAgo(365),
      noticeSentBefore: daysAgo(30),
      unverifiedBefore: daysAgo(7),
      piiBefore: daysAgo(90),
      sessionCreatedBefore: daysAgo(90),
    });
  });

  it("takes the session cap from the session lifetime, not a second copy", () => {
    expect(cutoffs(NOW).sessionCreatedBefore).toEqual(
      new Date(NOW.getTime() - SESSION_ABSOLUTE_MAX_AGE_MS),
    );
  });
});

describe("inactivityReference", () => {
  const createdAt = new Date("2025-01-01T00:00:00Z");

  it("is the last sign-in", () => {
    const lastLoginAt = new Date("2025-03-01T00:00:00Z");
    expect(inactivityReference({ lastLoginAt, createdAt })).toEqual(
      lastLoginAt,
    );
  });

  it("falls back to creation for a user who never signed in", () => {
    expect(inactivityReference({ lastLoginAt: null, createdAt })).toEqual(
      createdAt,
    );
  });
});

describe("noticeIsCurrent", () => {
  const reference = daysAgo(340);

  it("counts a notice sent after the reference", () => {
    expect(noticeIsCurrent(reference, daysAgo(5))).toBe(true);
  });

  it("does not count a missing notice or one from before a later sign-in", () => {
    expect(noticeIsCurrent(reference, null)).toBe(false);
    expect(noticeIsCurrent(reference, daysAgo(400))).toBe(false);
    expect(noticeIsCurrent(reference, reference)).toBe(false);
  });
});

describe("inactivityDeadline", () => {
  const reference = daysAgo(340);

  it("is 365 days after the reference for a notice sent on time", () => {
    const noticeSentAt = daysAfter(reference, 335);
    expect(inactivityDeadline(reference, noticeSentAt)).toEqual(
      daysAfter(reference, 365),
    );
  });

  it("is 365 days after the reference when no notice is on record", () => {
    expect(inactivityDeadline(reference, null)).toEqual(
      daysAfter(reference, 365),
    );
  });

  it("gives a late notice its full 30 days", () => {
    const noticeSentAt = daysAfter(reference, 400);
    expect(inactivityDeadline(reference, noticeSentAt)).toEqual(
      daysAfter(noticeSentAt, 30),
    );
  });

  it("ignores a notice that a later sign-in superseded", () => {
    const staleNotice = daysAfter(reference, -10);
    expect(inactivityDeadline(reference, staleNotice)).toEqual(
      daysAfter(reference, 365),
    );
  });
});

describe("dates", () => {
  it("puts the notice at 335 days and the deactivated tombstone at 30", () => {
    expect(inactivityNoticeDue(NOW)).toEqual(daysAfter(NOW, 335));
    expect(deactivatedTombstoneAt(NOW)).toEqual(daysAfter(NOW, 30));
  });

  it("builds the tombstone email from the id", () => {
    expect(tombstoneEmail("abc")).toBe("deleted+abc@invalid");
  });
});
