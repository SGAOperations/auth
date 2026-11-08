import { randomBytes } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { submitAccessRequest } from "@/lib/access-requests/submit";
import type { AccessInputError } from "@/lib/access-requests/input";
import { prisma } from "@/lib/prisma";
import { createPosition, createUser } from "@/test/factories";

// The submitter list is global, so the tests snapshot it and put it back.
let snapshot: { positionId: string; addedAt: Date }[];

beforeAll(async () => {
  snapshot = await prisma.accessSubmitterPosition.findMany();
});

afterAll(async () => {
  await prisma.accessSubmitterPosition.deleteMany();
  await prisma.accessSubmitterPosition.createMany({ data: snapshot });
});

const TEAM = "T0SUBMIT";
const rand = Math.random().toString(36).slice(2, 8);
let seq = 0;
const newKey = () => `acc-${rand}-${(seq += 1)}`;
const newSlackUserId = () => `U${randomBytes(6).toString("hex").toUpperCase()}`;

interface Scenario {
  /** Positions the user holds: `listed` ones go on the submitter list. */
  held?: { key?: string; listed?: boolean; deleted?: boolean }[];
  status?: "ACTIVE" | "DEACTIVATED";
  isAdmin?: boolean;
  linked?: boolean;
  linkTeam?: string;
  emptyList?: boolean;
}

async function scenario({
  held = [{ listed: true }],
  status = "ACTIVE",
  isAdmin = false,
  linked = true,
  linkTeam = TEAM,
}: Scenario = {}) {
  await prisma.accessSubmitterPosition.deleteMany();
  const user = await createUser({ status, isAdmin, preferredName: "Lex" });
  const slackUserId = newSlackUserId();
  if (linked) {
    await prisma.slackIdentity.create({
      data: {
        userId: user.id,
        slackTeamId: linkTeam,
        slackUserId,
        linkedVia: "IMPORT",
      },
    });
  }
  const positions = [];
  for (const spec of held) {
    const position = await createPosition({
      key: spec.key ?? newKey(),
      deletedAt: spec.deleted ? new Date() : null,
    });
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: position.id },
    });
    if (spec.listed) {
      await prisma.accessSubmitterPosition.create({
        data: { positionId: position.id },
      });
    }
    positions.push(position);
  }
  return { user, slackUserId, positions };
}

const marker = () => `Prod-${randomBytes(4).toString("hex")}`;

const rowsFor = (product: string) =>
  prisma.accessRequest.findMany({ where: { product } });
const auditFor = (userId: string) =>
  prisma.auditEvent.findMany({
    where: { type: "ACCESS_REQUEST_SUBMITTED", actorUserId: userId },
  });

async function expectRefusal(
  setup: Scenario,
  expected: Awaited<ReturnType<typeof submitAccessRequest>>,
  text?: (product: string) => string,
) {
  const { user, slackUserId } = await scenario(setup);
  const product = marker();
  const outcome = await submitAccessRequest({
    slackTeamId: TEAM,
    slackUserId,
    text: text ? text(product) : `${product} | Edit access`,
  });
  expect(outcome).toEqual(expected);
  expect(await rowsFor(product)).toHaveLength(0);
  expect(
    await prisma.accessRequest.count({ where: { requesterId: user.id } }),
  ).toBe(0);
  expect(await auditFor(user.id)).toHaveLength(0);
}

describe("submitAccessRequest refusals write nothing", () => {
  it("refuses an unlinked Slack user", async () => {
    await scenario();
    const product = marker();
    const outcome = await submitAccessRequest({
      slackTeamId: TEAM,
      slackUserId: newSlackUserId(),
      text: `${product} | Edit`,
    });
    expect(outcome).toEqual({ status: "not_linked" });
    expect(await rowsFor(product)).toHaveLength(0);
  });

  it("refuses a link made in another workspace", async () => {
    await expectRefusal({ linkTeam: "T0OTHERW" }, { status: "not_linked" });
  });

  it("refuses a deactivated user", async () => {
    await expectRefusal({ status: "DEACTIVATED" }, { status: "inactive" });
  });

  it("refuses a holder of an unlisted position only", async () => {
    await expectRefusal(
      { held: [{ listed: false }] },
      { status: "not_submitter" },
    );
  });

  it("refuses everyone while the list is empty", async () => {
    const { user, slackUserId } = await scenario({ held: [{ listed: true }] });
    await prisma.accessSubmitterPosition.deleteMany();
    const product = marker();
    const outcome = await submitAccessRequest({
      slackTeamId: TEAM,
      slackUserId,
      text: `${product} | Edit`,
    });
    expect(outcome).toEqual({ status: "not_submitter" });
    expect(await rowsFor(product)).toHaveLength(0);
    expect(await auditFor(user.id)).toHaveLength(0);
  });

  it("refuses a listed position that is soft-deleted", async () => {
    await expectRefusal(
      { held: [{ listed: true, deleted: true }] },
      { status: "not_submitter" },
    );
  });

  it("refuses an admin who holds no listed position", async () => {
    await expectRefusal(
      { isAdmin: true, held: [] },
      { status: "not_submitter" },
    );
  });

  it.each<[AccessInputError, (product: string) => string]>([
    ["usage", () => ""],
    ["usage", () => "help"],
    ["usage", (product) => product],
    ["missing_part", () => " | Edit"],
    ["missing_part", (product) => `${product} | `],
    ["product_too_long", () => `${"p".repeat(101)} | Edit`],
    ["access_too_long", (product) => `${product} | ${"a".repeat(501)}`],
    ["bad_characters", (product) => `${product} | a\`b`],
    ["bad_characters", (product) => `${product} | a\u0007b`],
  ])("refuses invalid input (%s)", async (error, text) => {
    await expectRefusal({}, { status: "invalid", error }, text);
  });
});

describe("submitAccessRequest success", () => {
  it("records the request, its position snapshot and one audit row", async () => {
    const { user, slackUserId, positions } = await scenario({
      held: [{ listed: true }],
    });
    const product = marker();

    const outcome = await submitAccessRequest({
      slackTeamId: TEAM,
      slackUserId,
      text: `  ${product}   | Edit   access to  Finance `,
    });

    expect(outcome.status).toBe("submitted");
    if (outcome.status !== "submitted") return;

    const rows = await rowsFor(product);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: outcome.requestId,
      requesterId: user.id,
      positionKey: positions[0].key,
      positionName: positions[0].name,
      product,
      access: "Edit access to Finance",
    });
    expect(outcome.copy).toContain(
      `Access request: Lex (${positions[0].name}) needs Edit access to Finance on ${product}.`,
    );

    const audits = await auditFor(user.id);
    expect(audits).toHaveLength(1);
    expect(audits[0]).toMatchObject({
      actorType: "USER",
      targetType: "USER",
      targetId: user.id,
      metadata: {
        accessRequestId: outcome.requestId,
        positionKey: positions[0].key,
      },
    });
  });

  it("records the lowest listed held key when several are listed", async () => {
    const low = `aaa-${rand}-${(seq += 1)}`;
    const high = `zzz-${rand}-${(seq += 1)}`;
    const unlisted = `000-${rand}-${(seq += 1)}`;
    const { slackUserId } = await scenario({
      held: [
        { key: high, listed: true },
        { key: low, listed: true },
        { key: unlisted, listed: false },
      ],
    });
    const product = marker();

    const outcome = await submitAccessRequest({
      slackTeamId: TEAM,
      slackUserId,
      text: `${product} | Edit`,
    });

    expect(outcome.status).toBe("submitted");
    expect((await rowsFor(product))[0].positionKey).toBe(low);
  });

  it("keeps a bar and decoded characters in the access text", async () => {
    const { slackUserId } = await scenario();
    const product = marker();

    await submitAccessRequest({
      slackTeamId: TEAM,
      slackUserId,
      text: `${product} | read &amp; write | admin`,
    });

    expect((await rowsFor(product))[0].access).toBe("read & write | admin");
  });
});
