import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  addChannelMapping,
  channelsForPositions,
  listChannelMappings,
  removeChannelMapping,
} from "@/lib/slack/channel-mappings";
import { createPosition, createUser } from "@/test/factories";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const directUrl = process.env.TEST_DIRECT_URL;

const DOWN_SQL = resolve(
  process.cwd(),
  "prisma/migrations/20261106000000_slack_channel_mapping/down.sql",
);

const rand = Math.random().toString(36).slice(2, 10);
const RAND = rand.toUpperCase();
const TEAM = `T${RAND}`;
let channelSeq = 0;
const channel = () => `C${RAND}${(channelSeq += 1)}`;

let adminId: string;
let slug: string;

beforeAll(async () => {
  slug = `slk-${rand}`;
  await prisma.product.create({
    data: {
      slug,
      name: "Channel mapping test product",
      baseUrl: `https://${slug}.northeasternsga.com`,
      isActive: false,
    },
  });
  adminId = (await createUser({ isAdmin: true })).id;
});

const roleKey = (name: string) => `${slug}-${name}`;
const add = (input: Record<string, unknown>) =>
  addChannelMapping(prisma, { createdById: adminId, ...input });

describe("addChannelMapping", () => {
  it("creates once, then reports the same triple as existing", async () => {
    const key = roleKey("admin");
    await createPosition({ key });
    const input = {
      roleKey: key,
      slackTeamId: TEAM,
      slackChannelId: channel(),
    };

    const first = await add(input);
    expect(first.status).toBe("created");
    if (first.status === "created") {
      expect(first.mapping).toMatchObject({
        roleKey: key,
        slackTeamId: TEAM,
        slackChannelId: input.slackChannelId,
        createdById: adminId,
      });
    }
    expect((await add(input)).status).toBe("exists");
  });

  it("allows one role on two channels and one channel on two roles", async () => {
    const a = roleKey("multi-a");
    const b = roleKey("multi-b");
    await createPosition({ key: a });
    await createPosition({ key: b });
    const shared = channel();

    expect(
      (await add({ roleKey: a, slackTeamId: TEAM, slackChannelId: shared }))
        .status,
    ).toBe("created");
    expect(
      (await add({ roleKey: a, slackTeamId: TEAM, slackChannelId: channel() }))
        .status,
    ).toBe("created");
    expect(
      (await add({ roleKey: b, slackTeamId: TEAM, slackChannelId: shared }))
        .status,
    ).toBe("created");
  });

  it("rejects malformed ids without writing a row", async () => {
    const key = roleKey("invalid");
    const position = await createPosition({ key });

    expect(
      await add({
        roleKey: key,
        slackTeamId: "E123",
        slackChannelId: channel(),
      }),
    ).toEqual({ status: "invalid", field: "slackTeamId" });
    expect(
      await add({ roleKey: key, slackTeamId: TEAM, slackChannelId: "c123" }),
    ).toEqual({ status: "invalid", field: "slackChannelId" });
    expect(
      await prisma.slackChannelMapping.count({
        where: { positionId: position.id },
      }),
    ).toBe(0);
  });

  it("reports an unknown or soft-deleted role", async () => {
    const gone = roleKey("retired");
    await createPosition({ key: gone, deletedAt: new Date() });
    for (const key of [roleKey("never-existed"), gone]) {
      expect(
        await add({
          roleKey: key,
          slackTeamId: TEAM,
          slackChannelId: channel(),
        }),
      ).toEqual({ status: "unknown_role" });
    }
  });

  it("reports a key that no product prefixes", async () => {
    const key = `org-${rand}-lead`;
    await createPosition({ key });
    expect(
      await add({ roleKey: key, slackTeamId: TEAM, slackChannelId: channel() }),
    ).toEqual({ status: "not_product_role" });
  });
});

describe("database CHECK backstop", () => {
  it("rejects a malformed channel id written around the helper", async () => {
    const position = await createPosition({ key: roleKey("check") });
    await expect(
      prisma.slackChannelMapping.create({
        data: {
          positionId: position.id,
          slackTeamId: TEAM,
          slackChannelId: "c123",
          createdById: adminId,
        },
      }),
    ).rejects.toThrow(/SlackChannelMapping_slackChannelId_check/);
  });
});

describe("removeChannelMapping", () => {
  it("returns the view once, then null", async () => {
    const key = roleKey("remove");
    await createPosition({ key });
    const created = await add({
      roleKey: key,
      slackTeamId: TEAM,
      slackChannelId: channel(),
    });
    if (created.status !== "created") throw new Error("setup failed");

    expect(await removeChannelMapping(prisma, created.mapping.id)).toEqual(
      created.mapping,
    );
    expect(await removeChannelMapping(prisma, created.mapping.id)).toBeNull();
  });
});

describe("listing", () => {
  it("leaves out mappings on soft-deleted positions", async () => {
    const key = roleKey("listed");
    const position = await createPosition({ key });
    const slackChannelId = channel();
    await add({ roleKey: key, slackTeamId: TEAM, slackChannelId });

    const visible = (await listChannelMappings(prisma)).filter(
      (m) => m.positionId === position.id,
    );
    expect(visible).toHaveLength(1);
    expect(await channelsForPositions(prisma, [position.id])).toEqual([
      { positionId: position.id, slackTeamId: TEAM, slackChannelId },
    ]);

    await prisma.position.update({
      where: { id: position.id },
      data: { deletedAt: new Date() },
    });
    expect(
      (await listChannelMappings(prisma)).some(
        (m) => m.positionId === position.id,
      ),
    ).toBe(false);
    expect(await channelsForPositions(prisma, [position.id])).toEqual([]);
  });

  it("returns an empty list for no position ids", async () => {
    expect(await channelsForPositions(prisma, [])).toEqual([]);
  });
});

// Runs on the migration role (TEST_DIRECT_URL), which owns the table, inside
// BEGIN ... ROLLBACK so the test branch keeps its table.
describe.skipIf(!directUrl)("down.sql", () => {
  it("drops the table and its migration record", async () => {
    const client = new Client({ connectionString: directUrl });
    await client.connect();
    try {
      await client.query("BEGIN");
      await client.query(readFileSync(DOWN_SQL, "utf8"));
      const { rows } = await client.query<{ gone: boolean; recorded: boolean }>(
        `SELECT to_regclass('"SlackChannelMapping"') IS NULL AS gone,
                EXISTS (
                  SELECT 1 FROM _prisma_migrations
                  WHERE migration_name = '20261106000000_slack_channel_mapping'
                ) AS recorded`,
      );
      expect(rows[0]).toEqual({ gone: true, recorded: false });
    } finally {
      await client.query("ROLLBACK");
      await client.end();
    }
  });
});
