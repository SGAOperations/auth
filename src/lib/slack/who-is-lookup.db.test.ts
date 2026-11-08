import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { loadWhoIs } from "@/lib/slack/who-is-lookup";
import { createPosition, createUser } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
const TEAM = `T${rand}`;
let slackSeq = 0;
const slackId = () => `U${rand}${(slackSeq += 1)}`;

async function linkedUser(
  overrides: Parameters<typeof createUser>[0] = {},
  slackTeamId = TEAM,
) {
  const user = await createUser(overrides);
  const slackUserId = slackId();
  await prisma.slackIdentity.create({
    data: {
      userId: user.id,
      slackTeamId,
      slackUserId,
      linkedVia: "SLACK_OPENID",
    },
  });
  return { user, slackUserId };
}

const hold = (userId: string, positionId: string) =>
  prisma.userPosition.create({ data: { userId, positionId } });

describe("loadWhoIs", () => {
  it("returns a linked person's positions with each direct manager", async () => {
    const caller = await linkedUser();
    const target = await linkedUser({
      name: "Jane Doe",
      preferredName: "Janie",
    });
    const manager = await createPosition({
      name: "President",
      category: "Executive Board",
    });
    const vp = await createPosition({
      name: "VP of Finance",
      category: "Executive Board",
      isLeadership: true,
      managerPositionId: manager.id,
    });
    await hold(target.user.id, vp.id);

    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });

    expect(result).toEqual({
      kind: "found",
      name: "Janie",
      positions: [
        {
          name: "VP of Finance",
          category: "Executive Board",
          isLeadership: true,
          manager: { name: "President", category: "Executive Board" },
        },
      ],
    });
  });

  it("gives a position with no manager a null manager", async () => {
    const caller = await linkedUser();
    const target = await linkedUser();
    const root = await createPosition({ name: "Root" });
    await hold(target.user.id, root.id);

    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });

    expect(result).toMatchObject({
      kind: "found",
      positions: [{ name: "Root", category: null, manager: null }],
    });
  });

  it("answers a person with no positions", async () => {
    const caller = await linkedUser();
    const target = await linkedUser();
    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });
    expect(result).toMatchObject({ kind: "found", positions: [] });
  });

  it("returns target_unlinked for a Slack user with no link", async () => {
    const caller = await linkedUser();
    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: slackId(),
    });
    expect(result).toEqual({ kind: "target_unlinked" });
  });

  it("returns target_unlinked for a deactivated target", async () => {
    const caller = await linkedUser();
    const target = await linkedUser({ status: "DEACTIVATED" });
    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });
    expect(result).toEqual({ kind: "target_unlinked" });
  });

  it("returns target_unlinked for a link in another workspace", async () => {
    const caller = await linkedUser();
    const target = await linkedUser({}, `T${rand}OTHER`);
    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });
    expect(result).toEqual({ kind: "target_unlinked" });
  });

  it("returns caller_unlinked for an unlinked and for a deactivated caller", async () => {
    const target = await linkedUser();
    const deactivated = await linkedUser({ status: "DEACTIVATED" });
    for (const callerSlackUserId of [slackId(), deactivated.slackUserId]) {
      const result = await loadWhoIs(prisma, {
        slackTeamId: TEAM,
        callerSlackUserId,
        targetSlackUserId: target.slackUserId,
      });
      expect(result).toEqual({ kind: "caller_unlinked" });
    }
  });

  it("leaves out a soft-deleted position", async () => {
    const caller = await linkedUser();
    const target = await linkedUser();
    const live = await createPosition({ name: "Live" });
    const gone = await createPosition({ name: "Gone", deletedAt: new Date() });
    await hold(target.user.id, live.id);
    await hold(target.user.id, gone.id);

    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });

    expect(result).toMatchObject({
      kind: "found",
      positions: [{ name: "Live" }],
    });
  });

  it("lets a caller look themselves up", async () => {
    const self = await linkedUser();
    const result = await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: self.slackUserId,
      targetSlackUserId: self.slackUserId,
    });
    expect(result.kind).toBe("found");
  });

  it("reads only: no audit rows and no change to the target", async () => {
    const caller = await linkedUser();
    const target = await linkedUser();
    const position = await createPosition();
    await hold(target.user.id, position.id);
    const auditBefore = await prisma.auditEvent.count();

    await loadWhoIs(prisma, {
      slackTeamId: TEAM,
      callerSlackUserId: caller.slackUserId,
      targetSlackUserId: target.slackUserId,
    });

    expect(await prisma.auditEvent.count()).toBe(auditBefore);
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: target.user.id },
      select: { updatedAt: true },
    });
    expect(after.updatedAt).toEqual(target.user.updatedAt);
  });
});
