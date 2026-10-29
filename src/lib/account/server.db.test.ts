import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import { createPosition, createUser } from "@/test/factories";
import { loadAccountOverview, updateOwnProfile } from "./server";

const rand = Math.random().toString(36).slice(2, 10);
const prefix = `t53-${rand}`;

function product(suffix: string, overrides: Record<string, unknown> = {}) {
  const slug = `${prefix}-${suffix}`;
  return {
    slug,
    name: `Product ${suffix}`,
    baseUrl: `https://${slug}.northeasternsga.com`,
    ...overrides,
  };
}

/** The test database may hold other products; look only at this file's. */
async function mySlugs(userId: string) {
  const overview = await loadAccountOverview(userId);
  return (overview?.tools ?? [])
    .map((tool) => tool.slug.slice(prefix.length + 1))
    .sort();
}

describe("account overview", () => {
  let financeKey: string;
  let financePositionId: string;

  beforeAll(async () => {
    const position = await createPosition();
    financeKey = position.key;
    financePositionId = position.id;
    await prisma.product.createMany({
      data: [
        product("everyone"),
        product("finance", { visibleToPositionKeys: [financeKey] }),
        product("senate", { visibleToPositionKeys: [`${prefix}-senator`] }),
        product("inactive", { isActive: false }),
      ],
    });
  });

  afterAll(async () => {
    await prisma.product.deleteMany({
      where: { slug: { startsWith: prefix } },
    });
    await prisma.userPosition.deleteMany({
      where: { positionId: financePositionId },
    });
    await prisma.position.deleteMany({ where: { id: financePositionId } });
  });

  it("shows a user with no positions only the products open to everyone", async () => {
    const user = await createUser();
    expect(await mySlugs(user.id)).toEqual(["everyone"]);
  });

  it("adds a product when a position unlocks it, and drops it when the position is deleted", async () => {
    const user = await createUser();
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: financePositionId },
    });

    expect(await mySlugs(user.id)).toEqual(["everyone", "finance"]);
    const held = await loadAccountOverview(user.id);
    expect(held?.positions.map((p) => p.key)).toEqual([financeKey]);

    await prisma.position.update({
      where: { id: financePositionId },
      data: { deletedAt: new Date() },
    });
    try {
      expect(await mySlugs(user.id)).toEqual(["everyone"]);
      expect((await loadAccountOverview(user.id))?.positions).toEqual([]);
    } finally {
      await prisma.position.update({
        where: { id: financePositionId },
        data: { deletedAt: null },
      });
    }
  });

  it("returns the profile fields", async () => {
    const user = await createUser({ preferredName: "Sam" });
    expect((await loadAccountOverview(user.id))?.profile).toEqual({
      email: user.email,
      name: user.name,
      preferredName: "Sam",
    });
  });

  it("returns null for a deactivated user and for an unknown id", async () => {
    const deactivated = await createUser({ status: "DEACTIVATED" });
    expect(await loadAccountOverview(deactivated.id)).toBeNull();
    expect(
      await loadAccountOverview("00000000-0000-7000-8000-000000000000"),
    ).toBeNull();
  });
});

describe("updateOwnProfile", () => {
  it("updates the caller's names and clears the preferred name", async () => {
    const user = await createUser({ preferredName: "Sam" });
    const other = await createUser();

    expect(
      await updateOwnProfile(user.id, {
        name: "Samuel Lee",
        preferredName: null,
      }),
    ).toEqual({ updated: true });

    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.name).toBe("Samuel Lee");
    expect(row.preferredName).toBeNull();
    const untouched = await prisma.user.findUniqueOrThrow({
      where: { id: other.id },
    });
    expect(untouched.name).toBe(other.name);
  });

  it("changes nothing for a deactivated user", async () => {
    const user = await createUser({ status: "DEACTIVATED" });
    expect(
      await updateOwnProfile(user.id, { name: "New Name", preferredName: "N" }),
    ).toEqual({ updated: false });
    const row = await prisma.user.findUniqueOrThrow({ where: { id: user.id } });
    expect(row.name).toBe(user.name);
    expect(row.preferredName).toBeNull();
  });
});
