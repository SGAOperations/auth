import { describe, expect, it } from "vitest";
import {
  acceptState,
  completionBannerCopy,
  emailConfirmed,
  recipientEligibility,
  recipientOptions,
  relativeFrom,
  statusCardView,
  transferErrorCopy,
  type AcceptView,
  type InFlightTransfer,
  type RecipientCandidate,
} from "@/lib/admin/transfer-view";
import { formatEt } from "@/lib/email/layout";

const NOW = new Date("2026-10-20T15:00:00Z");
const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

function candidate(
  overrides: Partial<RecipientCandidate> & { id: string },
): RecipientCandidate {
  return {
    name: `Name ${overrides.id}`,
    preferredName: null,
    email: `${overrides.id}@northeastern.edu`,
    status: "ACTIVE",
    twoFactorEnabled: true,
    ...overrides,
  };
}

describe("recipientEligibility", () => {
  it("accepts an active admin with two-factor", () => {
    expect(recipientEligibility(candidate({ id: "a" }), "pa")).toEqual({
      eligible: true,
    });
  });

  it.each([
    ["SELF", { id: "pa" }],
    ["DEACTIVATED", { id: "a", status: "DEACTIVATED" as const }],
    ["NO_MFA", { id: "a", twoFactorEnabled: false }],
  ])("refuses with %s", (reason, overrides) => {
    expect(recipientEligibility(candidate(overrides), "pa")).toEqual({
      eligible: false,
      reason,
    });
  });
});

describe("recipientOptions", () => {
  it("lists eligible people first, each group in the given order, with reasons", () => {
    const options = recipientOptions(
      [
        candidate({ id: "no-mfa", twoFactorEnabled: false }),
        candidate({ id: "ok-1", name: "Zed", preferredName: "Ada" }),
        candidate({ id: "off", status: "DEACTIVATED" }),
        candidate({ id: "ok-2" }),
      ],
      "pa",
    );
    expect(options.map((option) => option.id)).toEqual([
      "ok-1",
      "ok-2",
      "no-mfa",
      "off",
    ]);
    expect(options[0].name).toBe("Ada");
    expect(options.map((option) => option.unavailableReason)).toEqual([
      null,
      null,
      "Two-factor authentication isn't set up",
      "Account is deactivated",
    ]);
  });
});

describe("emailConfirmed", () => {
  it("requires the exact email, trimming only surrounding space", () => {
    expect(emailConfirmed("a@x.edu", "a@x.edu")).toBe(true);
    expect(emailConfirmed("  a@x.edu ", "a@x.edu")).toBe(true);
    expect(emailConfirmed("A@x.edu", "a@x.edu")).toBe(false);
    expect(emailConfirmed("a@x.ed", "a@x.edu")).toBe(false);
    expect(emailConfirmed("", "a@x.edu")).toBe(false);
  });
});

describe("transferErrorCopy", () => {
  it("names the reason a recipient is ineligible", () => {
    expect(transferErrorCopy("RECIPIENT_INELIGIBLE", "NO_MFA", "sender")).toBe(
      "That person can't receive Primary Admin. Two-factor authentication isn't set up.",
    );
    expect(transferErrorCopy("RECIPIENT_INELIGIBLE", undefined, "sender")).toBe(
      "That person can't receive Primary Admin.",
    );
    expect(transferErrorCopy("RECIPIENT_INELIGIBLE", "BOGUS", "sender")).toBe(
      "That person can't receive Primary Admin.",
    );
  });

  it("tells a recipient without two-factor to enroll", () => {
    expect(
      transferErrorCopy("RECIPIENT_INELIGIBLE", "NO_MFA", "recipient"),
    ).toBe("Set up two-factor authentication before accepting.");
  });

  it("maps known codes and falls back to a generic line", () => {
    expect(transferErrorCopy("TRANSFER_IN_FLIGHT", undefined, "sender")).toBe(
      "A transfer is already in progress.",
    );
    expect(
      transferErrorCopy("NOT_TRANSFER_RECIPIENT", undefined, "recipient"),
    ).toBe("You don't have permission to do that.");
    expect(transferErrorCopy("toString", undefined, "sender")).toBe(
      "Something went wrong. Nothing was changed.",
    );
  });
});

describe("relativeFrom", () => {
  it("uses minutes, hours or days by distance", () => {
    expect(relativeFrom(new Date(NOW.getTime() + 45 * 60_000), NOW)).toBe(
      "in 45 minutes",
    );
    expect(relativeFrom(new Date(NOW.getTime() + 23 * HOUR), NOW)).toBe(
      "in 23 hours",
    );
    expect(relativeFrom(new Date(NOW.getTime() + 3 * DAY), NOW)).toBe(
      "in 3 days",
    );
    expect(relativeFrom(new Date(NOW.getTime() - 2 * HOUR), NOW)).toBe(
      "2 hours ago",
    );
  });
});

describe("formatEt across a DST boundary", () => {
  it("renders the same instant in EDT and then EST", () => {
    // US clocks fell back on 2026-11-01 at 06:00 UTC.
    expect(formatEt(new Date("2026-11-01T05:30:00Z"))).toBe(
      "November 1, 2026 at 1:30 AM ET",
    );
    expect(formatEt(new Date("2026-11-01T07:30:00Z"))).toBe(
      "November 1, 2026 at 2:30 AM ET",
    );
  });
});

function transfer(overrides: Partial<InFlightTransfer> = {}): InFlightTransfer {
  return {
    id: "t1",
    status: "PENDING_ACCEPTANCE",
    fromUserId: "pa",
    toUserId: "rcpt",
    acceptanceExpiresAt: new Date(NOW.getTime() + 7 * DAY),
    executesAt: null,
    fromUser: { name: "Pat Admin", preferredName: null },
    toUser: { name: "Riley Recipient", preferredName: null },
    ...overrides,
  };
}

const viewerOf = (
  id: string,
  overrides: { isPrimaryAdmin?: boolean; isAdmin?: boolean } = {},
) => ({
  id,
  isAdmin: true,
  isPrimaryAdmin: false,
  status: "ACTIVE" as const,
  ...overrides,
});

describe("statusCardView", () => {
  it("pending: the sender can cancel, the recipient can review and decline, others only read", () => {
    const sender = statusCardView(
      transfer(),
      viewerOf("pa", { isPrimaryAdmin: true }),
      NOW,
    );
    expect(sender).toMatchObject({
      title: "Primary Admin transfer pending",
      canCancel: true,
      canAccept: false,
      canDecline: false,
    });
    expect(sender.description).toContain("Riley Recipient to accept");
    expect(sender.description).toContain(
      formatEt(new Date(NOW.getTime() + 7 * DAY)),
    );

    expect(statusCardView(transfer(), viewerOf("rcpt"), NOW)).toMatchObject({
      canCancel: false,
      canAccept: true,
      canDecline: true,
    });
    expect(statusCardView(transfer(), viewerOf("other"), NOW)).toMatchObject({
      canCancel: false,
      canAccept: false,
      canDecline: false,
    });
  });

  it("pending past its deadline can no longer be accepted", () => {
    const late = new Date(NOW.getTime() + 8 * DAY);
    expect(statusCardView(transfer(), viewerOf("rcpt"), late)).toMatchObject({
      canAccept: false,
      canDecline: true,
    });
  });

  it("cooling: says when it takes effect, and only the sender can cancel", () => {
    const executesAt = new Date(NOW.getTime() + 23 * HOUR);
    const cooling = transfer({ status: "COOLING", executesAt });

    const sender = statusCardView(
      cooling,
      viewerOf("pa", { isPrimaryAdmin: true }),
      NOW,
    );
    expect(sender).toMatchObject({
      title: "Primary Admin transfer accepted",
      canCancel: true,
      canAccept: false,
    });
    expect(sender.description).toBe(
      `Riley Recipient accepted. They become Primary Admin ${formatEt(executesAt)} (in 23 hours). Pat Admin can cancel until then.`,
    );

    expect(statusCardView(cooling, viewerOf("rcpt"), NOW)).toMatchObject({
      canCancel: false,
      canAccept: false,
      canDecline: true,
    });
  });

  it("a sender who is no longer the Primary Admin gets no cancel button", () => {
    expect(statusCardView(transfer(), viewerOf("pa"), NOW).canCancel).toBe(
      false,
    );
  });

  it("cooling without a time still reads sensibly", () => {
    const view = statusCardView(
      transfer({ status: "COOLING", executesAt: null }),
      viewerOf("other"),
      NOW,
    );
    expect(view.description).toBe(
      "Riley Recipient accepted. Pat Admin can cancel until it takes effect.",
    );
  });
});

describe("completionBannerCopy", () => {
  it("names both people and the completion time", () => {
    const completedAt = new Date("2026-10-19T14:00:00Z");
    expect(
      completionBannerCopy({
        id: "t1",
        completedAt,
        fromUser: { name: "Pat Admin", preferredName: null },
        toUser: { name: "Riley Recipient", preferredName: "Ri" },
      }),
    ).toBe(
      `Ri is now the Primary Admin (since ${formatEt(completedAt)}). Pat Admin remains an admin.`,
    );
  });
});

describe("acceptState", () => {
  const view = (overrides: Partial<AcceptView> = {}): AcceptView => ({
    id: "t1",
    status: "PENDING_ACCEPTANCE",
    acceptanceExpiresAt: new Date(NOW.getTime() + DAY),
    executesAt: null,
    fromUser: { name: "Pat Admin", preferredName: null },
    ...overrides,
  });

  it("maps each status", () => {
    expect(acceptState(view(), NOW)).toEqual({
      kind: "pending",
      fromName: "Pat Admin",
      expiresAt: new Date(NOW.getTime() + DAY),
    });
    const executesAt = new Date(NOW.getTime() + DAY);
    expect(acceptState(view({ status: "COOLING", executesAt }), NOW)).toEqual({
      kind: "cooling",
      executesAt,
    });
    expect(acceptState(view({ status: "COMPLETED" }), NOW)).toEqual({
      kind: "completed",
    });
    expect(acceptState(view({ status: "CANCELLED" }), NOW)).toEqual({
      kind: "cancelled",
    });
    expect(acceptState(view({ status: "EXPIRED" }), NOW)).toEqual({
      kind: "expired",
    });
  });

  it("reads a pending request past its deadline as expired", () => {
    expect(
      acceptState(
        view({ acceptanceExpiresAt: new Date(NOW.getTime() - 1) }),
        NOW,
      ),
    ).toEqual({ kind: "expired" });
  });
});
