import { beforeEach, describe, expect, it, vi } from "vitest";

// The module builds its default notifier at import, which reads the mailer and
// the environment. None of it is used here: tests build their own.
vi.mock("@/lib/email/server", () => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({ logger: {} }));
vi.mock("@/lib/env", () => ({ env: {} }));
vi.mock("@/lib/auth/settings", () => ({
  toAuthSettings: () => ({ baseURL: "https://auth.northeasternsga.com" }),
}));

import { prepareTemplate, type TemplateName } from "@/lib/email/templates";
import {
  createTransferNotifier,
  type TransferNotifierDeps,
} from "@/lib/jobs/pa-transfer-notify";
import type { TransferNotice } from "@/lib/jobs/pa-transfer";
import { resolveLinkTarget } from "@/lib/token-links/actions";
import { createCapturingMailer } from "@/test/capturing-mailer";

const ORIGIN = "https://auth.northeasternsga.com";
const WEEK = new Date("2026-11-03T12:00:00Z");
const DAY = new Date("2026-10-28T12:00:00Z");

const FROM = {
  id: "from",
  email: "jordan@northeastern.edu",
  name: "Jordan Lee",
  preferredName: null,
  status: "ACTIVE",
};
const TO = {
  id: "to",
  email: "sam@northeastern.edu",
  name: "Samuel Rivera",
  preferredName: "Sam Rivera",
  status: "ACTIVE",
};

function setup(
  overrides: {
    to?: Partial<typeof TO>;
    admins?: { email: string }[];
    completedAt?: Date | null;
    executesAt?: Date | null;
  } = {},
) {
  const mailer = createCapturingMailer();
  const log = { warn: vi.fn(), error: vi.fn() };
  const findMany = vi.fn().mockResolvedValue(overrides.admins ?? []);
  const db = {
    primaryAdminTransfer: {
      findUniqueOrThrow: vi.fn().mockResolvedValue({
        acceptanceExpiresAt: WEEK,
        executesAt: "executesAt" in overrides ? overrides.executesAt : DAY,
        completedAt: "completedAt" in overrides ? overrides.completedAt : DAY,
        fromUser: FROM,
        toUser: { ...TO, ...overrides.to },
      }),
    },
    user: { findMany },
  } as unknown as TransferNotifierDeps["db"];
  const notify = createTransferNotifier({
    db,
    mailer: mailer as unknown as TransferNotifierDeps["mailer"],
    origin: ORIGIN,
    log,
  });
  return { notify, mailer, log, findMany };
}

const notice = (
  kind: TransferNotice["kind"],
  extra: Partial<TransferNotice> = {},
): TransferNotice => ({
  kind,
  transferId: "t1",
  fromUserId: "from",
  toUserId: "to",
  ...extra,
});

// Every message must be valid against its template, as the real mailer checks.
function expectValid(message: { template: string; data: unknown }) {
  const prepared = prepareTemplate(
    message.template as TemplateName,
    message.data,
  );
  expect(prepared.ok, JSON.stringify(prepared)).toBe(true);
  return prepared;
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("initiated", () => {
  it("mails the recipient a plain accept link and the initiator a confirmation", async () => {
    const { notify, mailer } = setup();
    await notify(notice("initiated"));

    expect(mailer.sent).toEqual([
      {
        to: TO.email,
        template: "pa-transfer-initiated",
        data: {
          role: "recipient",
          url: `${ORIGIN}/admin/transfer/accept`,
          fromName: "Jordan Lee",
          acceptBy: WEEK,
        },
      },
      {
        to: FROM.email,
        template: "pa-transfer-initiated",
        data: { role: "initiator", toName: "Sam Rivera", acceptBy: WEEK },
      },
    ]);
    for (const message of mailer.sent) expectValid(message);
    expect(
      resolveLinkTarget(
        "pa-transfer-initiated",
        "url",
        `${ORIGIN}/admin/transfer/accept`,
      ),
    ).toEqual({ ok: true });
  });
});

describe("accepted", () => {
  it("mails the initiator the cancel link and the recipient the date", async () => {
    const { notify, mailer } = setup();
    await notify(notice("accepted", { cancelToken: "raw token/1" }));

    expect(mailer.sent).toEqual([
      {
        to: FROM.email,
        template: "pa-transfer-accepted",
        data: {
          role: "initiator",
          cancelUrl: `${ORIGIN}/transfer/cancel?token=raw%20token%2F1`,
          toName: "Sam Rivera",
          executesAt: DAY,
        },
      },
      {
        to: TO.email,
        template: "pa-transfer-accepted",
        data: { role: "recipient", fromName: "Jordan Lee", executesAt: DAY },
      },
    ]);
    for (const message of mailer.sent) expectValid(message);
    const link = expectValid(mailer.sent[0]);
    if (!link.ok) throw new Error("unreachable");
    expect(
      resolveLinkTarget("pa-transfer-accepted", "cancelUrl", link.links[0].url),
    ).toEqual({ ok: true });
  });

  it.each([
    ["no cancel token", notice("accepted"), {}],
    [
      "no execution date",
      notice("accepted", { cancelToken: "t" }),
      { executesAt: null },
    ],
  ])("refuses a notice with %s", async (_label, input, overrides) => {
    const { notify, mailer } = setup(overrides);
    await expect(notify(input)).rejects.toThrow("needs a cancel token");
    expect(mailer.sent).toEqual([]);
  });
});

describe("cancelled", () => {
  it.each([
    ["cancelled", "cancelled"],
    ["declined", "declined"],
    ["recipient_ineligible", "recipient-ineligible"],
    ["sender_not_primary_admin", "cancelled"],
  ] as const)(
    "maps the stored reason %s to %s for both parties",
    async (stored, reason) => {
      const { notify, mailer } = setup();
      await notify(notice("cancelled", { reason: stored }));

      expect(mailer.sent).toEqual([
        {
          to: FROM.email,
          template: "pa-transfer-cancelled",
          data: { role: "initiator", otherName: "Sam Rivera", reason },
        },
        {
          to: TO.email,
          template: "pa-transfer-cancelled",
          data: { role: "recipient", otherName: "Jordan Lee", reason },
        },
      ]);
      for (const message of mailer.sent) expectValid(message);
    },
  );

  it("treats a missing reason as a plain cancel", async () => {
    const { notify, mailer } = setup();
    await notify(notice("cancelled"));
    expect(mailer.sent.map((m) => m.data.reason)).toEqual([
      "cancelled",
      "cancelled",
    ]);
  });

  it("does not mail a deactivated recipient when they were the reason", async () => {
    const { notify, mailer } = setup({ to: { status: "DEACTIVATED" } });
    await notify(notice("cancelled", { reason: "recipient_ineligible" }));
    expect(mailer.sent.map((m) => m.to)).toEqual([FROM.email]);
  });

  it("still mails a recipient who lost admin but is active", async () => {
    const { notify, mailer } = setup();
    await notify(notice("cancelled", { reason: "recipient_ineligible" }));
    expect(mailer.sent.map((m) => m.to)).toEqual([FROM.email, TO.email]);
  });

  it("mails a deactivated recipient for any other reason", async () => {
    const { notify, mailer } = setup({ to: { status: "DEACTIVATED" } });
    await notify(notice("cancelled", { reason: "declined" }));
    expect(mailer.sent.map((m) => m.to)).toEqual([FROM.email, TO.email]);
  });
});

describe("expired", () => {
  it("mails only the initiator", async () => {
    const { notify, mailer } = setup();
    await notify(notice("expired"));
    expect(mailer.sent).toEqual([
      {
        to: FROM.email,
        template: "pa-transfer-cancelled",
        data: { role: "initiator", otherName: "Sam Rivera", reason: "expired" },
      },
    ]);
    expectValid(mailer.sent[0]);
  });
});

describe("completed", () => {
  it("reaches both parties and every other active admin, and asks for no one else", async () => {
    const { notify, mailer, findMany } = setup({
      admins: [
        { email: "avery@northeastern.edu" },
        { email: "kai@northeastern.edu" },
      ],
    });
    await notify(notice("completed"));

    expect(findMany).toHaveBeenCalledWith({
      where: {
        status: "ACTIVE",
        isAdmin: true,
        id: { notIn: ["from", "to"] },
      },
      select: { email: true },
    });
    expect(mailer.sent.map((m) => [m.to, m.data.role])).toEqual([
      [FROM.email, "initiator"],
      [TO.email, "recipient"],
      ["avery@northeastern.edu", "admin"],
      ["kai@northeastern.edu", "admin"],
    ]);
    expect(mailer.sent[0].data).toEqual({
      role: "initiator",
      fromName: "Jordan Lee",
      toName: "Sam Rivera",
      completedAt: DAY,
    });
    for (const message of mailer.sent) expectValid(message);
  });

  it("refuses a notice for a transfer with no completion date", async () => {
    const { notify, mailer } = setup({ completedAt: null });
    await expect(notify(notice("completed"))).rejects.toThrow(
      "needs a completion date",
    );
    expect(mailer.sent).toEqual([]);
  });
});

describe("delivery", () => {
  it("logs a capped or failed send without throwing, and keeps going", async () => {
    const { notify, mailer, log } = setup();
    const results = [
      { status: "capped", cap: "global:1d" },
      { status: "sent" },
    ] as const;
    let call = 0;
    mailer.sendEmail = vi.fn(async () => results[call++]);

    await notify(notice("expired"));
    await notify(notice("cancelled"));

    expect(log.warn).toHaveBeenCalledWith("pa_transfer.email_not_sent", {
      transferId: "t1",
      template: "pa-transfer-cancelled",
      status: "capped",
    });
    expect(log.warn).toHaveBeenCalledTimes(1);
  });

  it("logs an invalid message by template and error name, then sends the rest", async () => {
    const { notify, mailer, log } = setup();
    const sent: string[] = [];
    mailer.sendEmail = vi.fn(async (message) => {
      if (message.to === FROM.email) throw new RangeError("bad name");
      sent.push(message.to);
      return { status: "sent" } as const;
    });

    await notify(notice("cancelled"));

    expect(sent).toEqual([TO.email]);
    expect(log.error).toHaveBeenCalledWith("pa_transfer.email_invalid", {
      transferId: "t1",
      template: "pa-transfer-cancelled",
      errorName: "RangeError",
    });
  });

  it("never puts the cancel token, an address or a name in a log call", async () => {
    const { notify, mailer, log } = setup();
    mailer.sendEmail = vi.fn(async () => ({
      status: "failed" as const,
    }));
    await notify(notice("accepted", { cancelToken: "super-secret-token" }));

    const logged = JSON.stringify([log.warn.mock.calls, log.error.mock.calls]);
    expect(log.warn).toHaveBeenCalled();
    expect(logged).not.toContain("super-secret-token");
    expect(logged).not.toContain("northeastern.edu");
    expect(logged).not.toContain("Sam");
  });
});
