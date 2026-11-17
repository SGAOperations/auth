import { randomBytes } from "node:crypto";
import { symmetricEncrypt } from "better-auth/crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  retireSlackUserTokens,
  slackTokenKey,
  type revokeSlackToken,
} from "@/lib/slack/user-token-retirement";
import { createUser } from "@/test/factories";

const key = slackTokenKey({ legacySecret: "L".repeat(32), secrets: undefined });

type Revoke = typeof revokeSlackToken;

async function storeToken(token: string, ciphertext?: string) {
  const user = await createUser();
  await prisma.slackUserToken.create({
    data: {
      userId: user.id,
      slackTeamId: "T0RETIRE",
      slackUserId: `U${randomBytes(6).toString("hex").toUpperCase()}`,
      scopes: "users.profile:write,users.profile:read",
      token: ciphertext ?? (await symmetricEncrypt({ key, data: token })),
    },
  });
  return user;
}

const auditFor = (userId: string) =>
  prisma.auditEvent.findMany({
    where: {
      targetId: userId,
      type: { in: ["SLACK_TOKEN_REVOKED", "SLACK_TOKEN_REVOKE_FAILED"] },
    },
  });

beforeEach(async () => {
  // The table is retired, so this suite is the only one that writes to it.
  await prisma.slackUserToken.deleteMany();
});

describe("retireSlackUserTokens", () => {
  it("a dry run counts the rows and writes nothing", async () => {
    const user = await storeToken("xoxp-dry");
    const revoke = vi.fn<Revoke>(async () => "revoked");

    const result = await retireSlackUserTokens(prisma, {
      apply: false,
      key,
      revoke,
    });

    expect(result).toEqual({
      found: 1,
      revoked: 0,
      alreadyInvalid: 0,
      failedUserIds: [],
    });
    expect(await prisma.slackUserToken.count()).toBe(1);
    expect(await auditFor(user.id)).toEqual([]);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("apply deletes every row, audits each as retired and revokes each token", async () => {
    const first = await storeToken("xoxp-one");
    const second = await storeToken("xoxp-two");
    const revoke = vi.fn<Revoke>(async () => "revoked");

    const result = await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke,
    });

    expect(result).toEqual({
      found: 2,
      revoked: 2,
      alreadyInvalid: 0,
      failedUserIds: [],
    });
    expect(await prisma.slackUserToken.count()).toBe(0);
    expect(revoke.mock.calls.map(([token]) => token).sort()).toEqual([
      "xoxp-one",
      "xoxp-two",
    ]);
    for (const user of [first, second]) {
      const rows = await auditFor(user.id);
      expect(rows).toHaveLength(1);
      expect(rows[0]).toMatchObject({
        type: "SLACK_TOKEN_REVOKED",
        actorType: "SYSTEM",
        actorUserId: null,
        ip: null,
        userAgent: null,
        metadata: { reason: "retired", slackTeamId: "T0RETIRE" },
      });
    }
  });

  it("counts a token Slack already reports dead as already invalid, not a failure", async () => {
    await storeToken("xoxp-dead");
    const result = await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke: async () => "already_invalid",
    });
    expect(result).toEqual({
      found: 1,
      revoked: 0,
      alreadyInvalid: 1,
      failedUserIds: [],
    });
  });

  it("deletes a row whose revoke fails, audits the failure and reports the user", async () => {
    const user = await storeToken("xoxp-fail");
    const result = await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke: async () => ({ failed: "ratelimited" }),
    });

    expect(result).toEqual({
      found: 1,
      revoked: 0,
      alreadyInvalid: 0,
      failedUserIds: [user.id],
    });
    expect(await prisma.slackUserToken.count()).toBe(0);
    const failed = (await auditFor(user.id)).find(
      (row) => row.type === "SLACK_TOKEN_REVOKE_FAILED",
    );
    expect(failed).toMatchObject({
      actorType: "SYSTEM",
      ip: null,
      userAgent: null,
      metadata: { reason: "retired", slackError: "ratelimited" },
    });
  });

  it("deletes an undecryptable row without calling Slack and reports it", async () => {
    const user = await storeToken("", "not-a-ciphertext");
    const revoke = vi.fn<Revoke>(async () => "revoked");

    const result = await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke,
    });

    expect(result.failedUserIds).toEqual([user.id]);
    expect(revoke).not.toHaveBeenCalled();
    expect(await prisma.slackUserToken.count()).toBe(0);
    const failed = (await auditFor(user.id)).find(
      (row) => row.type === "SLACK_TOKEN_REVOKE_FAILED",
    );
    expect(failed).toMatchObject({
      metadata: { reason: "retired", slackError: "undecryptable" },
    });
  });

  it("revokes at Slack before the row is deleted or audited", async () => {
    const user = await storeToken("xoxp-order");
    let rowsAtRevoke = -1;
    let auditAtRevoke = -1;

    await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke: async () => {
        rowsAtRevoke = await prisma.slackUserToken.count();
        auditAtRevoke = (await auditFor(user.id)).length;
        return "revoked";
      },
    });

    expect(rowsAtRevoke).toBe(1);
    expect(auditAtRevoke).toBe(0);
  });

  it("an interrupted run keeps the row and writes no audit row, and the next run finishes it", async () => {
    const user = await storeToken("xoxp-interrupted");
    const revoke = vi.fn<Revoke>(async () => "revoked");
    const transaction = vi
      .spyOn(prisma, "$transaction")
      .mockRejectedValueOnce(new Error("process stopped"));

    await expect(
      retireSlackUserTokens(prisma, { apply: true, key, revoke }),
    ).rejects.toThrow("process stopped");
    transaction.mockRestore();

    expect(revoke).toHaveBeenCalledTimes(1);
    expect(await prisma.slackUserToken.count()).toBe(1);
    expect(await auditFor(user.id)).toEqual([]);

    const again = await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke: async () => "already_invalid",
    });
    expect(again).toMatchObject({ found: 1, alreadyInvalid: 1 });
    expect(await prisma.slackUserToken.count()).toBe(0);
    expect(await auditFor(user.id)).toHaveLength(1);
  });

  it("finds nothing on a second run", async () => {
    await storeToken("xoxp-once");
    const revoke = vi.fn<Revoke>(async () => "revoked");
    await retireSlackUserTokens(prisma, { apply: true, key, revoke });

    const again = await retireSlackUserTokens(prisma, {
      apply: true,
      key,
      revoke,
    });
    expect(again).toEqual({
      found: 0,
      revoked: 0,
      alreadyInvalid: 0,
      failedUserIds: [],
    });
    expect(revoke).toHaveBeenCalledTimes(1);
  });
});
