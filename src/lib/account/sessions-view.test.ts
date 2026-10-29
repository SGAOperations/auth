import { describe, expect, it } from "vitest";
import {
  formatSessionMeta,
  revokeOutcome,
  sessionListSchema,
} from "./sessions-view";

const element = {
  id: "0190a0a0-0000-7000-8000-000000000001",
  createdAt: "2026-10-02T15:00:00.000Z",
  lastActiveAt: "2026-10-19T09:30:00.000Z",
  ip: "203.0.113.7",
  device: "Chrome on Windows",
  isCurrent: true,
};

describe("sessionListSchema", () => {
  it("accepts the list body", () => {
    expect(
      sessionListSchema.parse({ sessions: [element, { ...element, ip: null }] })
        .sessions,
    ).toHaveLength(2);
  });

  it("accepts an additive field on an element", () => {
    const parsed = sessionListSchema.parse({
      sessions: [{ ...element, location: "Boston" }],
    });
    expect(parsed.sessions[0].id).toBe(element.id);
  });

  it("rejects a body without a sessions array", () => {
    expect(sessionListSchema.safeParse({ error: "x" }).success).toBe(false);
  });
});

describe("formatSessionMeta", () => {
  it("joins last active, sign-in date and IP", () => {
    expect(formatSessionMeta(element, { timeZone: "UTC" })).toBe(
      "Active Oct 19, 2026 · Signed in Oct 2, 2026 · 203.0.113.7",
    );
  });

  it("omits the IP segment when there is none", () => {
    expect(
      formatSessionMeta({ ...element, ip: null }, { timeZone: "UTC" }),
    ).toBe("Active Oct 19, 2026 · Signed in Oct 2, 2026");
  });
});

describe("revokeOutcome", () => {
  it.each([
    [204, "revoked"],
    [404, "gone"],
    [401, "signed-out"],
    [403, "failed"],
    [500, "failed"],
  ] as const)("maps %i to %s", (status, outcome) => {
    expect(revokeOutcome(status)).toBe(outcome);
  });
});
