import { beforeAll, describe, expect, it, vi } from "vitest";

const flag = vi.hoisted(() => ({ value: "true" }));

vi.mock("@/lib/env", async (importOriginal) => {
  const original = await importOriginal<typeof import("@/lib/env")>();
  return {
    ...original,
    env: new Proxy(original.env, {
      get: (target, key) =>
        key === "SGAUTH_SLACK_MANDATE_ENABLED"
          ? flag.value
          : Reflect.get(target, key),
    }),
  };
});

import { prisma } from "@/lib/prisma";
import {
  getOwnSlackMandate,
  recordSlackMandateBlock,
} from "@/lib/slack/mandate";
import { createPosition, createUser } from "@/test/factories";

const HOUR_MS = 60 * 60 * 1000;
const rand = Math.random().toString(36).slice(2, 8).toUpperCase();
let slackSeq = 0;
const slackId = () => `U${rand}${(slackSeq += 1)}`;

let leadershipId: string;
let plainId: string;

beforeAll(async () => {
  leadershipId = (await createPosition({ isLeadership: true })).id;
  plainId = (await createPosition({ isLeadership: false })).id;
});

async function userHolding(positionId?: string) {
  const user = await createUser();
  if (positionId) {
    await prisma.userPosition.create({
      data: { userId: user.id, positionId },
    });
  }
  return user;
}

const linkSlack = (userId: string) =>
  prisma.slackIdentity.create({
    data: {
      userId,
      slackTeamId: "T0SGA",
      slackUserId: slackId(),
      linkedVia: "SLACK_OAUTH",
    },
  });

const storeToken = (userId: string) =>
  prisma.slackUserToken.create({
    data: {
      userId,
      slackTeamId: "T0SGA",
      slackUserId: slackId(),
      scopes: "users.profile:write,users.profile:read",
      token: "ciphertext-not-a-real-token",
    },
  });

const blocks = (userId: string) =>
  prisma.auditEvent.findMany({
    where: { targetId: userId, type: "SLACK_MANDATE_BLOCKED" },
  });

const seedEvent = (
  userId: string,
  type: "SLACK_MANDATE_BLOCKED" | "SLACK_TOKEN_GRANTED",
  createdAt: Date,
) =>
  prisma.auditEvent.create({
    data: {
      type,
      actorType: "SYSTEM",
      targetType: "USER",
      targetId: userId,
      metadata:
        type === "SLACK_MANDATE_BLOCKED"
          ? { surface: "session" }
          : {
              slackTeamId: "T0SGA",
              slackUserId: "U0",
              scopes: [],
              replaced: false,
            },
      createdAt,
    },
  });

describe("recordSlackMandateBlock", () => {
  it("writes one SYSTEM row with no address on the first block", async () => {
    const user = await userHolding(leadershipId);
    await recordSlackMandateBlock(user.id, "token");

    const rows = await blocks(user.id);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "SYSTEM",
      actorUserId: null,
      targetType: "USER",
      ip: null,
      userAgent: null,
      metadata: { surface: "token" },
    });
  });

  it("writes nothing for a second block within 24 hours", async () => {
    const user = await userHolding(leadershipId);
    await recordSlackMandateBlock(user.id, "session");
    await recordSlackMandateBlock(user.id, "token");
    await recordSlackMandateBlock(user.id, "session");
    expect(await blocks(user.id)).toHaveLength(1);
  });

  it("writes again after a grant", async () => {
    const user = await userHolding(leadershipId);
    const now = new Date();
    await seedEvent(
      user.id,
      "SLACK_MANDATE_BLOCKED",
      new Date(now.getTime() - 2 * HOUR_MS),
    );
    await seedEvent(
      user.id,
      "SLACK_TOKEN_GRANTED",
      new Date(now.getTime() - HOUR_MS),
    );

    await recordSlackMandateBlock(user.id, "session", now);
    expect(await blocks(user.id)).toHaveLength(2);

    await recordSlackMandateBlock(user.id, "session", now);
    expect(await blocks(user.id)).toHaveLength(2);
  });

  it("is not suppressed by a block older than 24 hours", async () => {
    const user = await userHolding(leadershipId);
    const now = new Date();
    await seedEvent(
      user.id,
      "SLACK_MANDATE_BLOCKED",
      new Date(now.getTime() - 25 * HOUR_MS),
    );

    await recordSlackMandateBlock(user.id, "session", now);
    expect(await blocks(user.id)).toHaveLength(2);
  });

  it("never throws, even for a user that does not exist", async () => {
    await expect(
      recordSlackMandateBlock("00000000-0000-7000-8000-000000000000", "token"),
    ).resolves.toBeUndefined();
  });
});

describe("getOwnSlackMandate", () => {
  it("blocks a leader without a token, and says whether Slack is linked", async () => {
    const unlinked = await userHolding(leadershipId);
    expect(await getOwnSlackMandate(unlinked)).toEqual({
      blocked: true,
      linked: false,
    });

    const linked = await userHolding(leadershipId);
    await linkSlack(linked.id);
    expect(await getOwnSlackMandate(linked)).toEqual({
      blocked: true,
      linked: true,
    });
  });

  it("does not block a leader who has allowed title updates", async () => {
    const user = await userHolding(leadershipId);
    await linkSlack(user.id);
    await storeToken(user.id);
    expect(await getOwnSlackMandate(user)).toEqual({
      blocked: false,
      linked: true,
    });
  });

  it("never blocks a non-leader, with or without a link", async () => {
    const none = await userHolding();
    expect(await getOwnSlackMandate(none)).toEqual({
      blocked: false,
      linked: false,
    });

    const nonLeader = await userHolding(plainId);
    await linkSlack(nonLeader.id);
    expect(await getOwnSlackMandate(nonLeader)).toEqual({
      blocked: false,
      linked: true,
    });
  });

  it("ignores a deleted leadership position", async () => {
    const gone = await createPosition({
      isLeadership: true,
      deletedAt: new Date(),
    });
    const user = await userHolding(gone.id);
    expect((await getOwnSlackMandate(user)).blocked).toBe(false);
  });

  it("blocks nobody while the flag is off", async () => {
    flag.value = "false";
    try {
      const user = await userHolding(leadershipId);
      expect(await getOwnSlackMandate(user)).toEqual({
        blocked: false,
        linked: false,
      });
    } finally {
      flag.value = "true";
    }
  });
});
