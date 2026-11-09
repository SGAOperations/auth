import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

// The consent needs SGAuth's Slack app settings; the team id is what the stubbed
// Slack answers with.
vi.mock("@/lib/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...original,
    env: {
      ...original.env,
      SLACK_CLIENT_ID: "123.456",
      SLACK_CLIENT_SECRET: "shh",
      SLACK_TEAM_ID: "T0SGA",
    },
  };
});

import { prisma } from "@/lib/prisma";
import { issueSlackLinkToken } from "@/lib/slack/identity";
import { OAUTH_STATE_PREFIX, createOAuthState } from "@/lib/slack/oauth-state";
import {
  finishSlackProfileAccess,
  getOwnSlackProfileAccess,
  startSlackProfileAccess,
  withdrawSlackProfileAccess,
} from "@/lib/slack/profile-access";
import { confirmSlackLinkToken, unlinkOwnSlack } from "@/lib/slack/service";
import { decryptSlackToken } from "@/lib/slack/user-token";
import { createPosition, createUser } from "@/test/factories";

const TEAM = "T0SGA";
const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
let slackSeq = 0;
const slackId = () => `U${rand}${(slackSeq += 1)}`;
const SCOPES = "users.profile:write,users.profile:read";

const grant = (
  slackUserId: string,
  token: string,
  patch: Record<string, unknown> = {},
) => ({
  ok: true,
  team: { id: TEAM },
  authed_user: {
    id: slackUserId,
    scope: SCOPES,
    access_token: token,
    token_type: "user",
  },
  ...patch,
});

/** A stand-in for Slack: answers the exchange, and records every revoked token. */
function slack(
  exchange: unknown,
  revoke: unknown = { ok: true, revoked: true },
) {
  const revoked: string[] = [];
  const fetchStub = vi.fn<typeof fetch>(async (url, init) => {
    if (String(url).endsWith("/oauth.v2.access")) {
      return Response.json(exchange);
    }
    const header = (init?.headers as Record<string, string>).Authorization;
    revoked.push(header.replace("Bearer ", ""));
    return Response.json(revoke);
  });
  return { fetch: fetchStub, revoked };
}

let leadershipId: string;
let productId: string;

beforeAll(async () => {
  leadershipId = (await createPosition({ isLeadership: true })).id;
  const slug = `consent-${rand.toLowerCase()}`;
  productId = (
    await prisma.product.create({
      data: {
        slug,
        name: "Consent test product",
        baseUrl: `https://${slug}.northeasternsga.com`,
      },
    })
  ).id;
});

const leader = async () => {
  const user = await createUser();
  await prisma.userPosition.create({
    data: { userId: user.id, positionId: leadershipId },
  });
  return user;
};

const audits = (userId: string, type: string) =>
  prisma.auditEvent.findMany({
    where: { targetId: userId, type: type as never },
  });

const storedToken = (userId: string) =>
  prisma.slackUserToken.findUnique({ where: { userId } });

/** Starts the consent and finishes it with the browser's own cookie. */
async function consent(
  userId: string,
  stub: ReturnType<typeof slack>,
  code = "c1",
) {
  const started = await startSlackProfileAccess(userId);
  if (typeof started === "string") throw new Error(started);
  return finishSlackProfileAccess(
    userId,
    { state: started.state, cookieState: started.state, code },
    { fetch: stub.fetch },
  );
}

describe("starting the consent", () => {
  it("does not let a non-leader start", async () => {
    const user = await createUser();
    expect(await startSlackProfileAccess(user.id)).toBe("not_leadership");
  });

  it("does not let a leader whose position was deleted start", async () => {
    const user = await leader();
    await prisma.position.update({
      where: { id: leadershipId },
      data: { deletedAt: new Date() },
    });
    try {
      expect(await startSlackProfileAccess(user.id)).toBe("not_leadership");
    } finally {
      await prisma.position.update({
        where: { id: leadershipId },
        data: { deletedAt: null },
      });
    }
  });

  it("sends a leader to Slack for the profile scopes with a single-use state", async () => {
    const user = await leader();
    const started = await startSlackProfileAccess(user.id);
    if (typeof started === "string") throw new Error(started);
    const url = new URL(started.url);
    expect(url.searchParams.get("user_scope")).toBe(SCOPES);
    expect(url.searchParams.has("scope")).toBe(false);
    expect(url.searchParams.get("state")).toBe(started.state);
    expect(url.searchParams.get("redirect_uri")).toMatch(
      /\/account\/slack\/profile-access\/callback$/,
    );
    expect(
      await prisma.verification.count({
        where: { identifier: { startsWith: OAUTH_STATE_PREFIX.consent } },
      }),
    ).toBeGreaterThan(0);
  });
});

describe("finishing the consent", () => {
  it("stores the token encrypted and writes SLACK_TOKEN_GRANTED", async () => {
    const user = await leader();
    const slackUserId = slackId();
    const stub = slack(grant(slackUserId, "xoxp-first"));

    expect(await consent(user.id, stub)).toBe("title_updates_allowed");

    const row = await storedToken(user.id);
    expect(row).toMatchObject({
      slackTeamId: TEAM,
      slackUserId,
      scopes: SCOPES,
    });
    expect(row?.token).not.toContain("xoxp-");
    expect(await decryptSlackToken(row?.token ?? "")).toBe("xoxp-first");
    expect(await getOwnSlackProfileAccess(user.id)).toEqual({
      grantedAt: row?.grantedAt,
    });

    const granted = await audits(user.id, "SLACK_TOKEN_GRANTED");
    expect(granted).toHaveLength(1);
    expect(granted[0]).toMatchObject({
      actorUserId: user.id,
      metadata: {
        slackTeamId: TEAM,
        slackUserId,
        scopes: ["users.profile:write", "users.profile:read"],
        replaced: false,
      },
    });
    expect(JSON.stringify(granted[0].metadata)).not.toContain("xoxp");
    expect(stub.revoked).toEqual([]);
  });

  it("links the Slack account of a user who has none", async () => {
    const user = await leader();
    const slackUserId = slackId();
    await consent(user.id, slack(grant(slackUserId, "xoxp-link")));

    expect(
      await prisma.slackIdentity.findUnique({ where: { userId: user.id } }),
    ).toMatchObject({
      slackTeamId: TEAM,
      slackUserId,
      linkedVia: "SLACK_OAUTH",
    });
    const linked = await audits(user.id, "SLACK_LINKED");
    expect(linked).toHaveLength(1);
    expect(linked[0].metadata).toMatchObject({
      via: "slack_oauth",
      slackUserId,
      replaced: false,
    });
  });

  it("does not link again for a user already linked to the same account", async () => {
    const user = await leader();
    const slackUserId = slackId();
    await prisma.slackIdentity.create({
      data: {
        userId: user.id,
        slackTeamId: TEAM,
        slackUserId,
        linkedVia: "SLACK_COMMAND",
      },
    });
    expect(await consent(user.id, slack(grant(slackUserId, "xoxp-same")))).toBe(
      "title_updates_allowed",
    );
    expect(await audits(user.id, "SLACK_LINKED")).toHaveLength(0);
    expect(await storedToken(user.id)).not.toBeNull();
  });

  it("stores nothing and revokes the token for a different Slack account", async () => {
    const user = await leader();
    await prisma.slackIdentity.create({
      data: {
        userId: user.id,
        slackTeamId: TEAM,
        slackUserId: slackId(),
        linkedVia: "SLACK_COMMAND",
      },
    });
    const stub = slack(grant(slackId(), "xoxp-other"));
    expect(await consent(user.id, stub)).toBe("different_account");
    expect(await storedToken(user.id)).toBeNull();
    expect(await audits(user.id, "SLACK_TOKEN_GRANTED")).toHaveLength(0);
    expect(stub.revoked).toEqual(["xoxp-other"]);
  });

  it("stores nothing and revokes the token for a Slack account another user holds", async () => {
    const holder = await createUser();
    const slackUserId = slackId();
    await prisma.slackIdentity.create({
      data: {
        userId: holder.id,
        slackTeamId: TEAM,
        slackUserId,
        linkedVia: "SLACK_COMMAND",
      },
    });
    const user = await leader();
    const stub = slack(grant(slackUserId, "xoxp-taken"));
    expect(await consent(user.id, stub)).toBe("taken");
    expect(await storedToken(user.id)).toBeNull();
    expect(
      await prisma.slackIdentity.findUnique({ where: { userId: user.id } }),
    ).toBeNull();
    expect(stub.revoked).toEqual(["xoxp-taken"]);
  });

  it("stores nothing and revokes the token for another workspace", async () => {
    const user = await leader();
    const stub = slack(
      grant(slackId(), "xoxp-team", { team: { id: "T0OTHER" } }),
    );
    expect(await consent(user.id, stub)).toBe("wrong_team");
    expect(await storedToken(user.id)).toBeNull();
    expect(stub.revoked).toEqual(["xoxp-team"]);
  });

  it("refuses a grant missing a scope, and revokes it", async () => {
    const user = await leader();
    const body = grant(slackId(), "xoxp-scope");
    body.authed_user.scope = "users.profile:write";
    const stub = slack(body);
    expect(await consent(user.id, stub)).toBe("missing_scope");
    expect(await storedToken(user.id)).toBeNull();
    expect(stub.revoked).toEqual(["xoxp-scope"]);
  });

  it("refuses a rotating token, and revokes it", async () => {
    const user = await leader();
    const body = grant(slackId(), "xoxp-rotating");
    Object.assign(body.authed_user, { refresh_token: "xoxe-1-a" });
    const stub = slack(body);
    expect(await consent(user.id, stub)).toBe("failed");
    expect(await storedToken(user.id)).toBeNull();
    expect(stub.revoked).toEqual(["xoxp-rotating"]);
  });

  it("revokes the token when the user lost leadership during the consent", async () => {
    const user = await leader();
    const started = await startSlackProfileAccess(user.id);
    if (typeof started === "string") throw new Error(started);
    await prisma.userPosition.deleteMany({ where: { userId: user.id } });
    const stub = slack(grant(slackId(), "xoxp-lost"));
    const outcome = await finishSlackProfileAccess(
      user.id,
      { state: started.state, cookieState: started.state, code: "c1" },
      { fetch: stub.fetch },
    );
    expect(outcome).toBe("not_leadership");
    expect(await storedToken(user.id)).toBeNull();
    expect(stub.revoked).toEqual(["xoxp-lost"]);
  });

  it("does not revoke when a re-grant brings back the same token", async () => {
    const user = await leader();
    const slackUserId = slackId();
    await consent(user.id, slack(grant(slackUserId, "xoxp-again")));
    const stub = slack(grant(slackUserId, "xoxp-again"));
    expect(await consent(user.id, stub)).toBe("title_updates_allowed");
    expect(stub.revoked).toEqual([]);
    const row = await storedToken(user.id);
    expect(await decryptSlackToken(row?.token ?? "")).toBe("xoxp-again");
    const granted = await audits(user.id, "SLACK_TOKEN_GRANTED");
    expect(granted.map((event) => event.metadata)).toContainEqual(
      expect.objectContaining({ replaced: true }),
    );
  });

  it("revokes the old token when a re-grant brings a different one", async () => {
    const user = await leader();
    const slackUserId = slackId();
    await consent(user.id, slack(grant(slackUserId, "xoxp-old")));
    const stub = slack(grant(slackUserId, "xoxp-new"));
    expect(await consent(user.id, stub)).toBe("title_updates_allowed");
    expect(stub.revoked).toEqual(["xoxp-old"]);
    const row = await storedToken(user.id);
    expect(await decryptSlackToken(row?.token ?? "")).toBe("xoxp-new");
  });

  it("refuses a replayed state and a state from the other flow", async () => {
    const user = await leader();
    const started = await startSlackProfileAccess(user.id);
    if (typeof started === "string") throw new Error(started);
    const input = {
      state: started.state,
      cookieState: started.state,
      code: "c1",
    };
    const first = slack(grant(slackId(), "xoxp-once"));
    expect(
      await finishSlackProfileAccess(user.id, input, { fetch: first.fetch }),
    ).toBe("title_updates_allowed");
    const replay = slack(grant(slackId(), "xoxp-twice"));
    expect(
      await finishSlackProfileAccess(user.id, input, { fetch: replay.fetch }),
    ).toBe("failed");
    expect(replay.fetch).not.toHaveBeenCalled();

    const connectState = await createOAuthState(
      OAUTH_STATE_PREFIX.connect,
      user.id,
      { nonce: "n" },
    );
    expect(
      await finishSlackProfileAccess(
        user.id,
        { state: connectState, cookieState: connectState, code: "c1" },
        { fetch: replay.fetch },
      ),
    ).toBe("failed");
  });

  it("refuses a state without this browser's cookie, or another user's state", async () => {
    const user = await leader();
    const started = await startSlackProfileAccess(user.id);
    if (typeof started === "string") throw new Error(started);
    const stub = slack(grant(slackId(), "xoxp-cookie"));
    expect(
      await finishSlackProfileAccess(
        user.id,
        { state: started.state, cookieState: undefined, code: "c1" },
        { fetch: stub.fetch },
      ),
    ).toBe("failed");

    const other = await leader();
    const otherStarted = await startSlackProfileAccess(other.id);
    if (typeof otherStarted === "string") throw new Error(otherStarted);
    expect(
      await finishSlackProfileAccess(
        user.id,
        {
          state: otherStarted.state,
          cookieState: otherStarted.state,
          code: "c1",
        },
        { fetch: stub.fetch },
      ),
    ).toBe("failed");
    expect(stub.fetch).not.toHaveBeenCalled();
  });
});

describe("ending the grant", () => {
  const fetchStub = vi.fn<typeof fetch>();
  beforeEach(() => {
    fetchStub.mockReset();
    fetchStub.mockImplementation(async () =>
      Response.json({ ok: true, revoked: true }),
    );
    vi.stubGlobal("fetch", fetchStub);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  const bearers = () =>
    fetchStub.mock.calls.map(
      ([, init]) => (init?.headers as Record<string, string>).Authorization,
    );

  async function granted() {
    const user = await leader();
    const slackUserId = slackId();
    await consent(user.id, slack(grant(slackUserId, `xoxp-${slackUserId}`)));
    return { user, token: `xoxp-${slackUserId}` };
  }

  it("withdraw deletes the row, audits it and revokes at Slack", async () => {
    const { user, token } = await granted();
    expect(await withdrawSlackProfileAccess(user.id)).toBe(true);
    expect(await storedToken(user.id)).toBeNull();
    const revoked = await audits(user.id, "SLACK_TOKEN_REVOKED");
    expect(revoked).toHaveLength(1);
    expect(revoked[0]).toMatchObject({
      actorUserId: user.id,
      metadata: { reason: "withdrawn", slackTeamId: TEAM },
    });
    expect(bearers()).toEqual([`Bearer ${token}`]);
  });

  it("withdraw is a no-op without a token, and works after leadership is lost", async () => {
    const nobody = await createUser();
    expect(await withdrawSlackProfileAccess(nobody.id)).toBe(false);
    expect(fetchStub).not.toHaveBeenCalled();

    const { user } = await granted();
    await prisma.userPosition.deleteMany({ where: { userId: user.id } });
    expect(await withdrawSlackProfileAccess(user.id)).toBe(true);
  });

  it("unlink removes the link and the token, and audits both", async () => {
    const { user, token } = await granted();
    expect(await unlinkOwnSlack(user.id)).toBe(true);
    expect(await storedToken(user.id)).toBeNull();
    expect(await audits(user.id, "SLACK_UNLINKED")).toHaveLength(1);
    const revoked = await audits(user.id, "SLACK_TOKEN_REVOKED");
    expect(revoked[0].metadata).toMatchObject({ reason: "unlinked" });
    expect(bearers()).toEqual([`Bearer ${token}`]);
  });

  it("linking another Slack account through a link token revokes the old token", async () => {
    const { user, token } = await granted();
    const { token: linkToken } = await issueSlackLinkToken(prisma, {
      productId,
      slackTeamId: TEAM,
      slackUserId: slackId(),
    });
    expect(await confirmSlackLinkToken(user.id, linkToken)).toBe("linked");
    expect(await storedToken(user.id)).toBeNull();
    const revoked = await audits(user.id, "SLACK_TOKEN_REVOKED");
    expect(revoked[0].metadata).toMatchObject({ reason: "relinked" });
    expect(bearers()).toEqual([`Bearer ${token}`]);
  });

  it("a failed revoke writes SLACK_TOKEN_REVOKE_FAILED and still deletes the row", async () => {
    const { user } = await granted();
    fetchStub.mockImplementation(async () =>
      Response.json({ ok: false, error: "ratelimited" }),
    );
    expect(await withdrawSlackProfileAccess(user.id)).toBe(true);
    expect(await storedToken(user.id)).toBeNull();
    const failed = await audits(user.id, "SLACK_TOKEN_REVOKE_FAILED");
    expect(failed).toHaveLength(1);
    expect(failed[0]).toMatchObject({
      actorUserId: user.id,
      metadata: { reason: "withdrawn", slackError: "ratelimited" },
    });
  });

  it("treats a token Slack already killed as revoked", async () => {
    const { user } = await granted();
    fetchStub.mockImplementation(async () =>
      Response.json({ ok: false, error: "token_revoked" }),
    );
    await withdrawSlackProfileAccess(user.id);
    expect(await audits(user.id, "SLACK_TOKEN_REVOKE_FAILED")).toHaveLength(0);
  });
});
