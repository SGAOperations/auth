import { describe, expect, it } from "vitest";
import {
  ACCEPTANCE_WINDOW_MS,
  COOLING_MS,
  TRANSFER_EVENTS,
  TRANSFER_STATUSES,
  checkTransition,
  recipientIneligibility,
  type TransferEvent,
} from "@/lib/jobs/pa-transfer-machine";

const NOW = new Date("2026-10-27T12:00:00Z");
const FUTURE = new Date(NOW.getTime() + 1000);

type Status = (typeof TRANSFER_STATUSES)[number];

// Every (status x event) pair, spelled out: a new status or event fails the
// exhaustiveness check below until it has an expected row here.
const EXPECTED: Record<Status, Record<TransferEvent, Status | null>> = {
  PENDING_ACCEPTANCE: {
    accept: "COOLING",
    decline: "CANCELLED",
    cancel: "CANCELLED",
    cancelByToken: null,
  },
  COOLING: {
    accept: null,
    decline: "CANCELLED",
    cancel: "CANCELLED",
    cancelByToken: "CANCELLED",
  },
  COMPLETED: {
    accept: null,
    decline: null,
    cancel: null,
    cancelByToken: null,
  },
  CANCELLED: {
    accept: null,
    decline: null,
    cancel: null,
    cancelByToken: null,
  },
  EXPIRED: { accept: null, decline: null, cancel: null, cancelByToken: null },
};

const PAIRS = TRANSFER_STATUSES.flatMap((status) =>
  TRANSFER_EVENTS.map((event) => [status, event] as const),
);

describe("constants", () => {
  it("are seven days and twenty-four hours", () => {
    expect(ACCEPTANCE_WINDOW_MS).toBe(7 * 24 * 60 * 60 * 1000);
    expect(COOLING_MS).toBe(24 * 60 * 60 * 1000);
  });
});

describe("checkTransition", () => {
  it("has an expectation for every status and event", () => {
    expect(Object.keys(EXPECTED).sort()).toEqual([...TRANSFER_STATUSES].sort());
    for (const row of Object.values(EXPECTED)) {
      expect(Object.keys(row).sort()).toEqual([...TRANSFER_EVENTS].sort());
    }
  });

  it.each(PAIRS)("%s + %s", (status, event) => {
    const expected = EXPECTED[status][event];
    const result = checkTransition(
      { status, acceptanceExpiresAt: FUTURE },
      event,
      NOW,
    );
    expect(result).toEqual(
      expected ? { ok: true, to: expected } : { ok: false },
    );
  });

  it("refuses accept exactly at acceptanceExpiresAt and after it", () => {
    const transfer = {
      status: "PENDING_ACCEPTANCE" as const,
      acceptanceExpiresAt: NOW,
    };
    expect(checkTransition(transfer, "accept", NOW)).toEqual({ ok: false });
    expect(
      checkTransition(transfer, "accept", new Date(NOW.getTime() + 1)),
    ).toEqual({ ok: false });
    expect(
      checkTransition(transfer, "accept", new Date(NOW.getTime() - 1)),
    ).toEqual({ ok: true, to: "COOLING" });
  });

  it("still allows cancel on COOLING after the row is past its acceptance window", () => {
    const transfer = {
      status: "COOLING" as const,
      acceptanceExpiresAt: new Date(NOW.getTime() - ACCEPTANCE_WINDOW_MS),
    };
    for (const event of ["cancel", "decline", "cancelByToken"] as const) {
      expect(checkTransition(transfer, event, NOW)).toEqual({
        ok: true,
        to: "CANCELLED",
      });
    }
  });
});

describe("recipientIneligibility", () => {
  const eligible = {
    id: "to",
    isAdmin: true,
    status: "ACTIVE" as const,
    twoFactorEnabled: true,
  };

  it("accepts an active admin with MFA", () => {
    expect(recipientIneligibility(eligible, "from")).toBeNull();
  });

  it.each([
    ["SELF", { id: "from" }],
    ["NOT_ADMIN", { isAdmin: false }],
    ["DEACTIVATED", { status: "DEACTIVATED" as const }],
    ["NO_MFA", { twoFactorEnabled: false }],
  ])("reports %s", (reason, overrides) => {
    expect(recipientIneligibility({ ...eligible, ...overrides }, "from")).toBe(
      reason,
    );
  });

  it("reports the first failing rule, in order", () => {
    const everythingWrong = {
      id: "from",
      isAdmin: false,
      status: "DEACTIVATED" as const,
      twoFactorEnabled: false,
    };
    expect(recipientIneligibility(everythingWrong, "from")).toBe("SELF");
    expect(
      recipientIneligibility({ ...everythingWrong, id: "to" }, "from"),
    ).toBe("NOT_ADMIN");
    expect(
      recipientIneligibility(
        { ...everythingWrong, id: "to", isAdmin: true },
        "from",
      ),
    ).toBe("DEACTIVATED");
    expect(
      recipientIneligibility(
        { ...everythingWrong, id: "to", isAdmin: true, status: "ACTIVE" },
        "from",
      ),
    ).toBe("NO_MFA");
  });
});
