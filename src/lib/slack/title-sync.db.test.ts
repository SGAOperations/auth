import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  SLACK_CALL_INTERVAL_MS,
  SLACK_LEADERSHIP_FIELD_LABEL,
  SLACK_PROFILE_GET_URL,
  SLACK_PROFILE_SET_URL,
  SLACK_TEAM_PROFILE_URL,
  SLACK_WRITE_INTERVAL_MS,
} from "@/lib/slack/profile-api";
import { SLACK_TITLE_MAX_LENGTH } from "@/lib/slack/title";
import {
  SlackLeadershipFieldMissingError,
  runSlackTitleSync,
} from "@/lib/slack/title-sync";
import { encryptSlackToken } from "@/lib/slack/user-token";
import { createPosition, createUser } from "@/test/factories";

const FIELD = "Xf0LEAD";
const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
let seq = 0;
const next = () => (seq += 1);

interface Account {
  title: string;
  field: string;
  /** Slack answers `ok` to a set but changes nothing. */
  ignoreSet?: boolean;
  /** Slack escapes `&`, `<` and `>` in what it returns. */
  escape?: boolean;
  /** Error code for a profile get. */
  getError?: string;
  /** Error code for a profile set. */
  setError?: string;
  rateLimitedOnGet?: boolean;
}

/** A stand-in for Slack, keyed by token, with a fake clock. */
function world() {
  let clock = 0;
  const accounts = new Map<string, Account>();
  let fields: unknown[] = [
    { id: FIELD, label: SLACK_LEADERSHIP_FIELD_LABEL, type: "text" },
  ];
  const calls: { url: string; token: string; at: number }[] = [];
  const escape = (value: string, on?: boolean) =>
    on
      ? value
          .replaceAll("&", "&amp;")
          .replaceAll("<", "&lt;")
          .replaceAll(">", "&gt;")
      : value;

  const fetchStub = vi.fn<typeof fetch>(async (input, init) => {
    const url = String(input);
    const token = (init?.headers as Record<string, string>).Authorization.slice(
      "Bearer ".length,
    );
    calls.push({ url, token, at: clock });
    const account = accounts.get(token);
    if (!account) return Response.json({ ok: false, error: "invalid_auth" });
    if (url === SLACK_TEAM_PROFILE_URL) {
      return Response.json({ ok: true, profile: { fields } });
    }
    if (url === SLACK_PROFILE_GET_URL) {
      if (account.rateLimitedOnGet) {
        return new Response("", {
          status: 429,
          headers: { "Retry-After": "30" },
        });
      }
      if (account.getError) {
        return Response.json({ ok: false, error: account.getError });
      }
      return Response.json({
        ok: true,
        profile: {
          title: escape(account.title, account.escape),
          fields: { [FIELD]: { value: escape(account.field, account.escape) } },
        },
      });
    }
    if (url === SLACK_PROFILE_SET_URL) {
      if (account.setError) {
        return Response.json({ ok: false, error: account.setError });
      }
      if (!account.ignoreSet) {
        const body = JSON.parse(String(init?.body)) as {
          profile: { title: string; fields: Record<string, { value: string }> };
        };
        account.title = body.profile.title;
        account.field = body.profile.fields[FIELD].value;
      }
      return Response.json({ ok: true });
    }
    throw new Error(`unexpected url ${url}`);
  });

  return {
    accounts,
    calls,
    fetch: fetchStub,
    now: () => clock,
    sleep: async (ms: number) => {
      clock += ms;
    },
    advance: (ms: number) => {
      clock += ms;
    },
    setFields: (value: unknown[]) => {
      fields = value;
    },
    sets: () => calls.filter((call) => call.url === SLACK_PROFILE_SET_URL),
  };
}

const log = () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() });

let team: string;
beforeEach(() => {
  team = `T${rand}${next()}`;
});

async function holder(
  slack: ReturnType<typeof world>,
  options: {
    position?: string;
    account?: Partial<Account>;
    teamId?: string;
    status?: "ACTIVE" | "DEACTIVATED";
    leadership?: boolean;
    deletedPosition?: boolean;
  } = {},
) {
  const n = next();
  const position = await createPosition({
    name: options.position ?? `Role ${n}`,
    isLeadership: options.leadership ?? true,
    deletedAt: options.deletedPosition ? new Date() : null,
  });
  const user = await createUser({ status: options.status ?? "ACTIVE" });
  await prisma.userPosition.create({
    data: { userId: user.id, positionId: position.id },
  });
  const token = `xoxp-${rand}-${n}`;
  const slackUserId = `U${rand}${n}`;
  await prisma.slackIdentity.create({
    data: {
      userId: user.id,
      slackTeamId: options.teamId ?? team,
      slackUserId,
      linkedVia: "SLACK_OAUTH",
    },
  });
  await prisma.slackUserToken.create({
    data: {
      userId: user.id,
      slackTeamId: options.teamId ?? team,
      slackUserId,
      scopes: "users.profile:write,users.profile:read",
      token: await encryptSlackToken(token),
    },
  });
  slack.accounts.set(token, { title: "", field: "", ...options.account });
  return { user, token, position };
}

const sync = (
  slack: ReturnType<typeof world>,
  overrides: Partial<Parameters<typeof runSlackTitleSync>[0]> = {},
) =>
  runSlackTitleSync({
    db: prisma,
    teamId: team,
    now: slack.now,
    sleep: slack.sleep,
    fetch: slack.fetch,
    dryRun: false,
    log: log(),
    ...overrides,
  });

const audits = (userId: string, type: string) =>
  prisma.auditEvent.findMany({
    where: { targetId: userId, type: type as never },
  });

const stored = (userId: string) =>
  prisma.slackUserToken.findUnique({ where: { userId } });

describe("runSlackTitleSync", () => {
  it("counts a leader whose profile already matches as unchanged", async () => {
    const slack = world();
    const { user } = await holder(slack, {
      position: "President",
      account: { title: "President", field: "President" },
    });
    const report = await sync(slack);
    expect(report).toMatchObject({ unchanged: 1, synced: 0, errors: 0 });
    expect(slack.sets()).toHaveLength(0);
    expect(await audits(user.id, "SLACK_TITLE_SET")).toHaveLength(0);
    const row = await stored(user.id);
    expect(row?.titleCheckedAt).not.toBeNull();
    expect(row?.titleSyncedAt).not.toBeNull();
  });

  it("writes a different title, reads it back and audits it", async () => {
    const slack = world();
    const { user } = await holder(slack, {
      position: "Treasurer",
      account: { title: "Old", field: "" },
    });
    const report = await sync(slack);
    expect(report).toMatchObject({ synced: 1, mismatched: 0, errors: 0 });
    expect(slack.sets()).toHaveLength(1);
    const [event] = await audits(user.id, "SLACK_TITLE_SET");
    expect(event).toMatchObject({
      actorType: "SYSTEM",
      targetType: "USER",
      metadata: { slackTeamId: team, title: "Treasurer" },
    });
    const row = await stored(user.id);
    expect(row?.titleCheckedAt).not.toBeNull();
    expect(row?.titleSyncedAt).not.toBeNull();
  });

  it("counts a write Slack ignored as a mismatch, not as synced", async () => {
    const slack = world();
    const { user } = await holder(slack, {
      position: "Secretary",
      account: { title: "Old", field: "", ignoreSet: true },
    });
    const logger = log();
    const report = await sync(slack, { log: logger });
    expect(report).toMatchObject({ synced: 0, mismatched: 1, errors: 0 });
    const [event] = await audits(user.id, "SLACK_TITLE_MISMATCH");
    expect(event.metadata).toEqual({
      slackTeamId: team,
      title: "Secretary",
      titleMatched: false,
      fieldMatched: false,
    });
    expect(await audits(user.id, "SLACK_TITLE_SET")).toHaveLength(0);
    expect(logger.warn).toHaveBeenCalledWith("slack_title_mismatch", {
      userId: user.id,
      titleMatched: false,
      fieldMatched: false,
    });
    const row = await stored(user.id);
    expect(row?.titleCheckedAt).not.toBeNull();
    expect(row?.titleSyncedAt).toBeNull();
  });

  it("treats Slack's escaping of & on read-back as a match", async () => {
    const slack = world();
    await holder(slack, {
      position: "Arts & Culture",
      account: { title: "", field: "", escape: true },
    });
    expect(await sync(slack)).toMatchObject({ synced: 1, mismatched: 0 });
  });

  it("marks a revoked token as unlinked and keeps the Slack link", async () => {
    const slack = world();
    const { user } = await holder(slack, {
      position: "Chair",
      account: { getError: "token_revoked" },
    });
    const report = await sync(slack);
    expect(report).toMatchObject({ unlinked: 1, errors: 0, synced: 0 });
    expect(await stored(user.id)).toBeNull();
    const [event] = await audits(user.id, "SLACK_TOKEN_REVOKED");
    expect(event).toMatchObject({
      actorType: "SYSTEM",
      metadata: { reason: "revoked_at_slack", slackTeamId: team },
    });
    expect(await audits(user.id, "SLACK_TOKEN_REVOKE_FAILED")).toHaveLength(0);
    expect(
      await prisma.slackIdentity.findUnique({ where: { userId: user.id } }),
    ).not.toBeNull();
    // auth.revoke is never called: the token is already dead.
    expect(slack.calls.every((call) => !call.url.endsWith("auth.revoke"))).toBe(
      true,
    );
  });

  it("leaves a grant replaced mid-run in place when the old one is revoked", async () => {
    const slack = world();
    const { user, token } = await holder(slack, {
      position: "Chair",
      account: { getError: "token_revoked" },
    });
    // The user re-grants after the run read its candidate but before the
    // revoke is handled: the replacement is live and must survive.
    const replacement = await encryptSlackToken(`${token}-new`);
    const fetchStub = slack.fetch;
    let replaced = false;
    const replacingFetch: typeof fetch = async (input, init) => {
      const response = await fetchStub(input, init);
      if (!replaced && String(input) === SLACK_PROFILE_GET_URL) {
        replaced = true;
        await prisma.slackUserToken.update({
          where: { userId: user.id },
          data: { token: replacement },
        });
      }
      return response;
    };
    const report = await sync(slack, { fetch: replacingFetch });
    expect(report).toMatchObject({ unlinked: 0, errors: 0, synced: 0 });
    expect((await stored(user.id))?.token).toBe(replacement);
    expect(await audits(user.id, "SLACK_TOKEN_REVOKED")).toHaveLength(0);
  });

  it("skips people who are not leaders, are deactivated, or are in another team", async () => {
    const slack = world();
    await holder(slack, { leadership: false });
    await holder(slack, { deletedPosition: true });
    await holder(slack, { status: "DEACTIVATED" });
    await holder(slack, { teamId: `${team}X` });
    const report = await sync(slack);
    expect(report.candidates).toBe(0);
    expect(slack.calls).toHaveLength(0);
  });

  it("refuses a title over the limit without writing", async () => {
    const slack = world();
    // A position name is capped at 100 characters, so the over-limit title is
    // the join of several valid names.
    const { user } = await holder(slack, { position: `A${"x".repeat(89)}` });
    for (const letter of ["B", "C"]) {
      const extra = await createPosition({
        name: `${letter}${"x".repeat(89)}`,
        isLeadership: true,
      });
      await prisma.userPosition.create({
        data: { userId: user.id, positionId: extra.id },
      });
    }
    const joined = 3 * 90 + 2 * " | ".length;
    expect(joined).toBeGreaterThan(SLACK_TITLE_MAX_LENGTH);
    const report = await sync(slack);
    expect(report).toMatchObject({ refused: 1, synced: 0 });
    expect(slack.sets()).toHaveLength(0);
    expect((await stored(user.id))?.titleCheckedAt).not.toBeNull();
  });

  it("stops at a 429, reports who remains and leaves them first next run", async () => {
    const slack = world();
    const limited = await holder(slack, {
      position: "A role",
      account: { rateLimitedOnGet: true },
    });
    await sync(slack, { dryRun: true });
    const report = await sync(slack);
    expect(report).toMatchObject({
      stoppedReason: "rate_limited",
      remaining: 1,
      errors: 0,
    });
    expect((await stored(limited.user.id))?.titleCheckedAt).toBeNull();
  });

  it("starts the least recently checked people first", async () => {
    const slack = world();
    const first = await holder(slack, { position: "First" });
    const second = await holder(slack, { position: "Second" });
    await prisma.slackUserToken.update({
      where: { userId: first.user.id },
      data: { titleCheckedAt: new Date() },
    });
    await sync(slack);
    const order = slack.sets().map((call) => call.token);
    expect(order[0]).toBe(second.token);
    expect(order[1]).toBe(first.token);
  });

  it("stops between people at the time budget, never between a set and its read-back", async () => {
    const slack = world();
    await holder(slack, { position: "One" });
    await holder(slack, { position: "Two" });
    // One person costs a field lookup, a get, a set and a read-back.
    const report = await sync(slack, { budgetMs: 1 });
    expect(report).toMatchObject({
      stoppedReason: "time_budget",
      synced: 1,
      remaining: 1,
    });
    const urls = slack.calls.map((call) => call.url);
    expect(urls).toEqual([
      SLACK_TEAM_PROFILE_URL,
      SLACK_PROFILE_GET_URL,
      SLACK_PROFILE_SET_URL,
      SLACK_PROFILE_GET_URL,
    ]);
  });

  it("paces calls and writes with the fake clock", async () => {
    const slack = world();
    await holder(slack, { position: "One" });
    await holder(slack, { position: "Two" });
    await holder(slack, { position: "Three" });
    await sync(slack);
    for (let i = 1; i < slack.calls.length; i += 1) {
      expect(slack.calls[i].at - slack.calls[i - 1].at).toBeGreaterThanOrEqual(
        SLACK_CALL_INTERVAL_MS,
      );
    }
    const sets = slack.sets();
    expect(sets).toHaveLength(3);
    for (let i = 1; i < sets.length; i += 1) {
      expect(sets[i].at - sets[i - 1].at).toBeGreaterThanOrEqual(
        SLACK_WRITE_INTERVAL_MS,
      );
    }
  });

  it("makes no set call and writes no row in a dry run", async () => {
    const slack = world();
    const { user } = await holder(slack, {
      position: "Dry",
      account: { title: "Old", field: "" },
    });
    const before = await prisma.auditEvent.count({
      where: { targetId: user.id },
    });
    const report = await sync(slack, { dryRun: true });
    expect(report).toMatchObject({ dryRun: true, wouldWrite: 1, synced: 0 });
    expect(slack.sets()).toHaveLength(0);
    expect(
      await prisma.auditEvent.count({ where: { targetId: user.id } }),
    ).toBe(before);
    const row = await stored(user.id);
    expect(row?.titleCheckedAt).toBeNull();
  });

  it("throws before any set when the Active Leadership field is missing", async () => {
    const slack = world();
    slack.setFields([{ id: "Xf0", label: "Phone", type: "text" }]);
    await holder(slack, { position: "Nobody" });
    await expect(sync(slack)).rejects.toBeInstanceOf(
      SlackLeadershipFieldMissingError,
    );
    expect(slack.sets()).toHaveLength(0);
  });

  it("counts an unknown Slack error and carries on to the next person", async () => {
    const slack = world();
    const bad = await holder(slack, {
      position: "Bad",
      account: { setError: "fatal_error", title: "Old" },
    });
    await holder(slack, { position: "Good", account: { title: "Old" } });
    const logger = log();
    const report = await sync(slack, { log: logger });
    expect(report).toMatchObject({ errors: 1, synced: 1 });
    expect(logger.error).toHaveBeenCalledWith("slack_title_sync_error", {
      userId: bad.user.id,
      step: "profile_set",
      slackError: "fatal_error",
    });
    expect((await stored(bad.user.id))?.titleCheckedAt).not.toBeNull();
  });

  it("counts an undecryptable token as an error and carries on", async () => {
    const slack = world();
    await holder(slack, { position: "Broken" });
    const report = await sync(slack, {
      decrypt: async () => {
        throw new Error("bad envelope");
      },
    });
    expect(report).toMatchObject({ errors: 1, synced: 0 });
  });
});
