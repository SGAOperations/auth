import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/test/factories";
import { applySlackLinkImport } from "./slack-links";

const rand = Math.random().toString(36).slice(2, 10).toUpperCase();
const TEAM = `T${rand}`;

describe("applySlackLinkImport", () => {
  it("links new rows, leaves existing links alone, and writes one BULK_IMPORT", async () => {
    const fresh = await createUser();
    const already = await createUser();
    const elsewhere = await createUser();
    await prisma.slackIdentity.create({
      data: {
        userId: elsewhere.id,
        slackTeamId: TEAM,
        slackUserId: `U${rand}OWN`,
        linkedVia: "SLACK_OPENID",
      },
    });
    await prisma.slackIdentity.create({
      data: {
        userId: already.id,
        slackTeamId: TEAM,
        slackUserId: `U${rand}SAME`,
        linkedVia: "SLACK_COMMAND",
      },
    });

    const plan = await applySlackLinkImport(prisma, {
      team: TEAM,
      sourceSha256: "a".repeat(64),
      rows: [
        { sgauthUserId: fresh.id, slackUserId: `U${rand}NEW` },
        { sgauthUserId: already.id, slackUserId: `U${rand}SAME` },
        { sgauthUserId: elsewhere.id, slackUserId: `U${rand}EXPORT` },
      ],
    });
    expect(plan.counts).toEqual({
      link: 1,
      unchanged: 1,
      conflict: 1,
      missing_user: 0,
    });

    const linked = await prisma.slackIdentity.findUniqueOrThrow({
      where: { userId: fresh.id },
    });
    expect(linked).toMatchObject({
      slackTeamId: TEAM,
      slackUserId: `U${rand}NEW`,
      linkedVia: "IMPORT",
    });
    const kept = await prisma.slackIdentity.findUniqueOrThrow({
      where: { userId: elsewhere.id },
    });
    expect(kept.slackUserId).toBe(`U${rand}OWN`);

    const events = await prisma.auditEvent.findMany({
      where: {
        type: "BULK_IMPORT",
        metadata: { path: ["slackTeamId"], equals: TEAM },
      },
    });
    expect(events).toHaveLength(1);
    expect(events[0].metadata).toMatchObject({
      source: "slack_links",
      linked: 1,
      unchanged: 1,
      conflicts: 1,
      missingUsers: 0,
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain(`U${rand}`);
  });
});
