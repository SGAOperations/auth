import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  authenticateProductKey,
  createProductApiKey,
  revokeProductApiKey,
} from "@/lib/product-api-keys";
import {
  SLACK_LINK_TOKEN_TTL_MS,
  consumeSlackLinkToken,
  issueSlackLinkToken,
  linkSlackIdentity,
  lookupSlackIdentities,
  readSlackLinkToken,
  unlinkSlackIdentity,
} from "@/lib/slack/identity";
import { createUser } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
const TEAM = `T${rand}`;
let slackSeq = 0;
const slackId = () => `U${rand}${(slackSeq += 1)}`;

let productId: string;

beforeAll(async () => {
  const slug = `slack-${rand.toLowerCase()}`;
  const product = await prisma.product.create({
    data: {
      slug,
      name: "Slack test product",
      baseUrl: `https://${slug}.northeasternsga.com`,
    },
  });
  productId = product.id;
});

describe("link tokens", () => {
  it("reads without spending, then is spent exactly once", async () => {
    const slackUserId = slackId();
    const { token, expiresAt } = await issueSlackLinkToken(prisma, {
      productId,
      slackTeamId: TEAM,
      slackUserId,
    });
    expect(expiresAt.getTime()).toBeGreaterThan(Date.now());

    const view = await readSlackLinkToken(prisma, token);
    expect(view).toMatchObject({ slackTeamId: TEAM, slackUserId, productId });
    expect(await readSlackLinkToken(prisma, token)).not.toBeNull();

    expect(await consumeSlackLinkToken(prisma, token)).toMatchObject({
      slackUserId,
    });
    expect(await consumeSlackLinkToken(prisma, token)).toBeNull();
    expect(await readSlackLinkToken(prisma, token)).toBeNull();
  });

  it("stores only the hash", async () => {
    const { token } = await issueSlackLinkToken(prisma, {
      productId,
      slackTeamId: TEAM,
      slackUserId: slackId(),
    });
    const stored = await prisma.slackLinkToken.findMany({
      where: { productId },
      select: { tokenHash: true },
    });
    expect(stored.some((row) => row.tokenHash === token)).toBe(false);
  });

  it("is dead once expired", async () => {
    const issuedAt = new Date(Date.now() - SLACK_LINK_TOKEN_TTL_MS - 1000);
    const { token } = await issueSlackLinkToken(
      prisma,
      { productId, slackTeamId: TEAM, slackUserId: slackId() },
      issuedAt,
    );
    expect(await readSlackLinkToken(prisma, token)).toBeNull();
    expect(await consumeSlackLinkToken(prisma, token)).toBeNull();
  });

  it("is unknown when made up", async () => {
    expect(await readSlackLinkToken(prisma, "made-up")).toBeNull();
  });
});

describe("linkSlackIdentity", () => {
  it("links, keeps an identical link, and replaces the user's old one", async () => {
    const user = await createUser();
    const first = slackId();
    const second = slackId();
    const link = (slackUserId: string) =>
      linkSlackIdentity(prisma, {
        userId: user.id,
        slackTeamId: TEAM,
        slackUserId,
        linkedVia: "SLACK_COMMAND",
        productId,
      });

    expect(await link(first)).toEqual({ status: "linked", replaced: null });
    expect(await link(first)).toEqual({ status: "unchanged" });
    expect(await link(second)).toEqual({
      status: "linked",
      replaced: { slackTeamId: TEAM, slackUserId: first },
    });
    const rows = await prisma.slackIdentity.findMany({
      where: { userId: user.id },
    });
    expect(rows).toHaveLength(1);
    expect(rows[0].slackUserId).toBe(second);
  });

  it("never moves a Slack account from one user to another", async () => {
    const owner = await createUser();
    const other = await createUser();
    const slackUserId = slackId();
    await linkSlackIdentity(prisma, {
      userId: owner.id,
      slackTeamId: TEAM,
      slackUserId,
      linkedVia: "SLACK_OPENID",
    });
    expect(
      await linkSlackIdentity(prisma, {
        userId: other.id,
        slackTeamId: TEAM,
        slackUserId,
        linkedVia: "SLACK_COMMAND",
      }),
    ).toEqual({ status: "taken" });
    expect(
      await prisma.slackIdentity.findUnique({ where: { userId: other.id } }),
    ).toBeNull();
  });

  it("unlinks once", async () => {
    const user = await createUser();
    const slackUserId = slackId();
    await linkSlackIdentity(prisma, {
      userId: user.id,
      slackTeamId: TEAM,
      slackUserId,
      linkedVia: "SLACK_OPENID",
    });
    expect(await unlinkSlackIdentity(prisma, user.id)).toEqual({
      slackTeamId: TEAM,
      slackUserId,
    });
    expect(await unlinkSlackIdentity(prisma, user.id)).toBeNull();
  });
});

describe("lookupSlackIdentities", () => {
  it("answers both directions, for active users in the workspace only", async () => {
    const active = await createUser();
    const deactivated = await createUser({ status: "DEACTIVATED" });
    const elsewhere = await createUser();
    const [a, d, e] = [slackId(), slackId(), slackId()];
    await prisma.slackIdentity.createMany({
      data: [
        {
          userId: active.id,
          slackTeamId: TEAM,
          slackUserId: a,
          linkedVia: "IMPORT",
        },
        {
          userId: deactivated.id,
          slackTeamId: TEAM,
          slackUserId: d,
          linkedVia: "IMPORT",
        },
        {
          userId: elsewhere.id,
          slackTeamId: "T0ELSEWHERE",
          slackUserId: e,
          linkedVia: "IMPORT",
        },
      ],
    });

    const bySlack = await lookupSlackIdentities(prisma, {
      slackTeamId: TEAM,
      slackUserIds: [a, d, e, "U0NOBODY"],
      userIds: [],
    });
    expect(bySlack).toEqual([
      { userId: active.id, slackTeamId: TEAM, slackUserId: a },
    ]);

    const byUser = await lookupSlackIdentities(prisma, {
      slackTeamId: TEAM,
      slackUserIds: [],
      userIds: [active.id, deactivated.id, elsewhere.id],
    });
    expect(byUser).toEqual(bySlack);

    expect(
      await lookupSlackIdentities(prisma, {
        slackTeamId: TEAM,
        slackUserIds: [],
        userIds: [],
      }),
    ).toEqual([]);
  });
});

describe("product API keys", () => {
  it("authenticates a created key until it is revoked", async () => {
    const admin = await createUser();
    const created = await createProductApiKey(prisma, {
      productId,
      name: "test",
      createdById: admin.id,
    });
    if (!created.ok) throw new Error("expected a key");

    const stored = await prisma.productApiKey.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(stored.keyHash).not.toContain(created.key);
    expect(JSON.stringify(stored)).not.toContain(created.key);

    expect(
      await authenticateProductKey(prisma, `Bearer ${created.key}`),
    ).toMatchObject({ productId, keyId: created.id });
    const used = await prisma.productApiKey.findUniqueOrThrow({
      where: { id: created.id },
    });
    expect(used.lastUsedAt).not.toBeNull();

    expect(
      await revokeProductApiKey(prisma, { productId, keyId: created.id }),
    ).toEqual({ id: created.id, prefix: created.prefix });
    expect(
      await revokeProductApiKey(prisma, { productId, keyId: created.id }),
    ).toBeNull();
    expect(
      await authenticateProductKey(prisma, `Bearer ${created.key}`),
    ).toBeNull();
  });

  it("holds at most three live keys per product", async () => {
    const admin = await createUser();
    const slug = `keys-${rand.toLowerCase()}`;
    const product = await prisma.product.create({
      data: {
        slug,
        name: "Keys",
        baseUrl: `https://${slug}.northeasternsga.com`,
      },
    });
    const create = () =>
      createProductApiKey(prisma, {
        productId: product.id,
        name: "k",
        createdById: admin.id,
      });
    for (let i = 0; i < 3; i++) expect((await create()).ok).toBe(true);
    expect(await create()).toEqual({ ok: false, code: "TOO_MANY_KEYS" });
  });
});
