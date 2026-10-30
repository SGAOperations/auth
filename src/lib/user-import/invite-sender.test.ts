import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({ audit: vi.fn() }));
vi.mock("@/lib/audit", () => ({ audit: mocks.audit }));

import type { SendResult } from "@/lib/email/mailer";
import type { AdminInviteResult } from "@/lib/set-password/service";
import {
  createInviteSender,
  type InviteSenderDeps,
} from "@/lib/user-import/invite-sender";

const NOW = new Date("2026-01-01T00:00:00Z");

function harness({
  user = { email: "ann@northeastern.edu", name: "Ann", preferredName: null },
  invite = { ok: true, url: "https://example.test/x", expiresInMinutes: 10080 },
  send = { status: "sent" },
}: {
  user?: {
    email: string;
    name: string;
    preferredName: string | null;
  } | null;
  invite?: AdminInviteResult;
  send?: SendResult;
} = {}) {
  const sendEmail = vi.fn(async () => send);
  const issueAdminInvite = vi.fn(async () => invite);
  const error = vi.fn();
  const deps = {
    prisma: { user: { findUnique: async () => user }, verification: {} },
    issueAdminInvite,
    mailer: { sendEmail },
    log: { error },
    now: () => NOW,
  } as unknown as InviteSenderDeps;
  return { send: createInviteSender(deps), sendEmail, issueAdminInvite, error };
}

beforeEach(() => {
  mocks.audit.mockReset();
});

describe("createInviteSender", () => {
  it("mails the invite, then audits USER_INVITED for the admin", async () => {
    const h = harness();
    await expect(h.send("u1", "admin-1")).resolves.toEqual({ status: "sent" });
    expect(h.sendEmail).toHaveBeenCalledWith({
      to: "ann@northeastern.edu",
      template: "set-password",
      data: {
        name: "Ann",
        url: "https://example.test/x",
        expiresInMinutes: 10080,
        kind: "admin-invite",
      },
    });
    expect(mocks.audit).toHaveBeenCalledWith({
      type: "USER_INVITED",
      actorType: "USER",
      actorUserId: "admin-1",
      targetType: "USER",
      targetId: "u1",
    });
  });

  it("prefers the preferred name", async () => {
    const h = harness({
      user: { email: "a@x.edu", name: "Ann", preferredName: "Annie" },
    });
    await h.send("u1", "admin-1");
    expect(h.sendEmail).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ name: "Annie" }),
      }),
    );
  });

  it("reports rate_limited without mailing or auditing", async () => {
    const h = harness({ invite: { ok: false, reason: "RATE_LIMITED" } });
    await expect(h.send("u1", "admin-1")).resolves.toEqual({
      status: "rate_limited",
    });
    expect(h.sendEmail).not.toHaveBeenCalled();
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it.each<SendResult>([
    { status: "capped", cap: "global:1d" },
    { status: "failed" },
  ])("does not audit a send that came to %j", async (send) => {
    const h = harness({ send });
    await expect(h.send("u1", "admin-1")).resolves.toEqual(send);
    expect(mocks.audit).not.toHaveBeenCalled();
  });

  it("fails for a user that no longer exists", async () => {
    const h = harness({ user: null });
    await expect(h.send("u1", "admin-1")).resolves.toEqual({
      status: "failed",
    });
    expect(h.issueAdminInvite).not.toHaveBeenCalled();
  });

  it("still reports sent when the audit write fails, and logs it", async () => {
    mocks.audit.mockRejectedValue(new Error("db down"));
    const h = harness();
    await expect(h.send("u1", "admin-1")).resolves.toEqual({ status: "sent" });
    expect(h.error).toHaveBeenCalledWith("user_import_invite_audit_failed", {
      userId: "u1",
    });
  });
});
