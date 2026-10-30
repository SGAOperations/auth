import { describe, expect, it } from "vitest";
import { INVITE_BATCH_MAX } from "@/lib/user-import/contract";
import {
  sendImportInvites,
  type InviteAttempt,
  type InviteDeps,
} from "@/lib/user-import/invites";

const ids = (count: number) => Array.from({ length: count }, (_, n) => `u${n}`);

interface Setup {
  inactive?: string[];
  withPassword?: string[];
  invited?: string[];
  attempt?: (userId: string, call: number) => InviteAttempt;
}

function harness(userIds: string[], setup: Setup = {}) {
  const sent: string[] = [];
  const sleeps: number[] = [];
  const inactive = new Set(setup.inactive ?? []);
  const db = {
    user: {
      findMany: async () =>
        userIds.filter((id) => !inactive.has(id)).map((id) => ({ id })),
    },
    account: {
      findMany: async () =>
        (setup.withPassword ?? []).map((userId) => ({ userId })),
    },
    auditEvent: {
      findMany: async () =>
        (setup.invited ?? []).map((targetId) => ({ targetId })),
    },
  } as unknown as InviteDeps["db"];
  const deps: InviteDeps = {
    db,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    sendInvite: async (userId) => {
      sent.push(userId);
      return setup.attempt?.(userId, sent.length) ?? { status: "sent" };
    },
  };
  return { deps, sent, sleeps };
}

describe("sendImportInvites", () => {
  it("sends to every eligible user", async () => {
    const users = ids(3);
    const { deps, sent } = harness(users);
    const outcome = await sendImportInvites(users, deps);
    expect(sent).toEqual(users);
    expect(outcome.counts.sent).toBe(3);
    expect(outcome.statuses.get("u1")).toBe("sent");
  });

  it("skips users who have a password or were invited before", async () => {
    const users = ids(4);
    const { deps, sent } = harness(users, {
      withPassword: ["u0"],
      invited: ["u1"],
    });
    const outcome = await sendImportInvites(users, deps);
    expect(sent).toEqual(["u2", "u3"]);
    expect(outcome.statuses.get("u0")).toBe("skipped_has_password");
    expect(outcome.statuses.get("u1")).toBe("skipped_already_invited");
    expect(outcome.counts).toMatchObject({
      sent: 2,
      skippedHasPassword: 1,
      skippedAlreadyInvited: 1,
    });
  });

  it("reports a user who is no longer active as failed, unsent", async () => {
    const users = ids(2);
    const { deps, sent } = harness(users, { inactive: ["u0"] });
    const outcome = await sendImportInvites(users, deps);
    expect(sent).toEqual(["u1"]);
    expect(outcome.statuses.get("u0")).toBe("failed");
  });

  it("stops after the batch limit and defers the rest", async () => {
    const users = ids(INVITE_BATCH_MAX + 10);
    const { deps, sent } = harness(users);
    const outcome = await sendImportInvites(users, deps);
    expect(sent).toHaveLength(INVITE_BATCH_MAX);
    expect(outcome.counts).toMatchObject({
      sent: INVITE_BATCH_MAX,
      deferredBatch: 10,
    });
    expect(outcome.statuses.get(`u${INVITE_BATCH_MAX}`)).toBe("deferred_batch");
  });

  it("stops for the day at the global cap", async () => {
    const users = ids(10);
    const { deps, sent } = harness(users, {
      attempt: (_id, call) =>
        call === 7
          ? { status: "capped", cap: "global:1d" }
          : { status: "sent" },
    });
    const outcome = await sendImportInvites(users, deps);
    expect(sent).toHaveLength(7);
    expect(outcome.counts).toMatchObject({ sent: 6, deferredDailyCap: 4 });
    expect(outcome.statuses.get("u6")).toBe("deferred_daily_cap");
  });

  it("keeps going after a per-recipient cap or limit", async () => {
    const users = ids(4);
    const { deps, sent } = harness(users, {
      attempt: (_id, call) => {
        if (call === 1) return { status: "capped", cap: "recipient:1d" };
        if (call === 2) return { status: "rate_limited" };
        return { status: "sent" };
      },
    });
    const outcome = await sendImportInvites(users, deps);
    expect(sent).toHaveLength(4);
    expect(outcome.counts).toMatchObject({ sent: 2, rateLimited: 2 });
  });

  it("reports a failed send and a throwing sender, and carries on", async () => {
    const users = ids(3);
    const { deps } = harness(users, {
      attempt: (id) => {
        if (id === "u1") throw new Error("boom");
        return id === "u0" ? { status: "failed" } : { status: "sent" };
      },
    });
    const outcome = await sendImportInvites(users, deps);
    expect(outcome.counts).toMatchObject({ failed: 2, sent: 1 });
  });

  it("spaces sends, but not before the first", async () => {
    const users = ids(3);
    const { deps, sleeps } = harness(users);
    await sendImportInvites(users, { ...deps, spacingMs: 250 });
    expect(sleeps).toEqual([250, 250]);
  });

  it("does nothing for no users", async () => {
    const { deps, sent } = harness([]);
    const outcome = await sendImportInvites([], deps);
    expect(sent).toEqual([]);
    expect(outcome.counts.sent).toBe(0);
  });
});
