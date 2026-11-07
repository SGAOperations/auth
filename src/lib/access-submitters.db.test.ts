import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  AccessSubmitterError,
  listSubmitterPositionKeys,
  listSubmitterPositions,
  setSubmitterPositionKeys,
} from "@/lib/access-submitters";
import { prisma } from "@/lib/prisma";
import { createAdmin, createPosition } from "@/test/factories";

// The list is global, so the tests snapshot it and put it back.
let snapshot: { positionId: string; addedAt: Date }[];
let adminId: string;

beforeAll(async () => {
  snapshot = await prisma.accessSubmitterPosition.findMany();
});

afterAll(async () => {
  await prisma.accessSubmitterPosition.deleteMany();
  await prisma.accessSubmitterPosition.createMany({ data: snapshot });
});

const rand = Math.random().toString(36).slice(2, 8);
let seq = 0;
const newKey = () => `sub-${rand}-${(seq += 1)}`;

const auditRows = () =>
  prisma.auditEvent.findMany({
    where: { type: "ACCESS_SUBMITTERS_UPDATED", actorUserId: adminId },
    orderBy: { createdAt: "asc" },
  });

// The audit log is append-only, so each test gets a fresh actor and reads only
// that actor's rows.
async function reset() {
  await prisma.accessSubmitterPosition.deleteMany();
  adminId = (await createAdmin()).id;
}

describe("setSubmitterPositionKeys", () => {
  it("writes the rows and one audit row with sorted before and after", async () => {
    await reset();
    const b = newKey();
    const a = newKey();
    await createPosition({ key: b });
    await createPosition({ key: a });

    const result = await setSubmitterPositionKeys({ keys: [b, a, b] }, adminId);

    const sorted = [a, b].sort();
    expect(result).toEqual({ changed: true, before: [], after: sorted });
    expect(await listSubmitterPositionKeys()).toEqual(sorted);

    const rows = await auditRows();
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      actorType: "USER",
      targetType: null,
      targetId: null,
      metadata: { before: [], after: sorted },
    });
  });

  it("replaces the list, recording the old and new sets", async () => {
    await reset();
    const keep = newKey();
    const drop = newKey();
    const add = newKey();
    await createPosition({ key: keep });
    await createPosition({ key: drop });
    await createPosition({ key: add });
    await setSubmitterPositionKeys({ keys: [keep, drop] }, adminId);

    const result = await setSubmitterPositionKeys(
      { keys: [add, keep] },
      adminId,
    );

    expect(result.changed).toBe(true);
    expect(result.before).toEqual([keep, drop].sort());
    expect(result.after).toEqual([add, keep].sort());
    expect(await listSubmitterPositionKeys()).toEqual([add, keep].sort());
    expect(await auditRows()).toHaveLength(2);
  });

  it("is a no-op for the same set: no rows and no audit row", async () => {
    await reset();
    const key = newKey();
    await createPosition({ key });
    await setSubmitterPositionKeys({ keys: [key] }, adminId);
    const before = await prisma.accessSubmitterPosition.findMany();

    const result = await setSubmitterPositionKeys(
      { keys: [key, key] },
      adminId,
    );

    expect(result.changed).toBe(false);
    expect(await prisma.accessSubmitterPosition.findMany()).toEqual(before);
    expect(await auditRows()).toHaveLength(1);
  });

  it("clears the list with an empty set", async () => {
    await reset();
    const key = newKey();
    await createPosition({ key });
    await setSubmitterPositionKeys({ keys: [key] }, adminId);

    const result = await setSubmitterPositionKeys({ keys: [] }, adminId);

    expect(result).toEqual({ changed: true, before: [key], after: [] });
    expect(await listSubmitterPositionKeys()).toEqual([]);
  });

  it("throws UNKNOWN_POSITION for an unknown key and changes nothing", async () => {
    await reset();
    const key = newKey();
    await createPosition({ key });
    await setSubmitterPositionKeys({ keys: [key] }, adminId);
    const missing = `no-such-${rand}`;

    const error = await setSubmitterPositionKeys(
      { keys: [missing] },
      adminId,
    ).catch((err: unknown) => err);

    expect(error).toBeInstanceOf(AccessSubmitterError);
    expect(error).toMatchObject({
      code: "UNKNOWN_POSITION",
      unknownKeys: [missing],
    });
    expect(await listSubmitterPositionKeys()).toEqual([key]);
    expect(await auditRows()).toHaveLength(1);
  });

  it("throws UNKNOWN_POSITION for a soft-deleted key", async () => {
    await reset();
    const key = newKey();
    const position = await createPosition({ key });
    await prisma.position.update({
      where: { id: position.id },
      data: { deletedAt: new Date() },
    });

    await expect(
      setSubmitterPositionKeys({ keys: [key] }, adminId),
    ).rejects.toMatchObject({ code: "UNKNOWN_POSITION", unknownKeys: [key] });
    expect(await prisma.accessSubmitterPosition.count()).toBe(0);
  });

  it("throws INVALID_INPUT for a malformed body", async () => {
    await reset();
    await expect(
      setSubmitterPositionKeys({ keys: ["Bad Key"] }, adminId),
    ).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(await auditRows()).toHaveLength(0);
  });
});

describe("listing", () => {
  it("drops a listed position once it is soft-deleted", async () => {
    await reset();
    const live = newKey();
    const gone = newKey();
    await createPosition({ key: live });
    const goneRow = await createPosition({ key: gone });
    await setSubmitterPositionKeys({ keys: [live, gone] }, adminId);

    await prisma.position.update({
      where: { id: goneRow.id },
      data: { deletedAt: new Date() },
    });

    expect(await listSubmitterPositionKeys()).toEqual([live]);
    expect(await listSubmitterPositions()).toMatchObject([{ key: live }]);
  });

  it("removes the stale row of a deleted position on the next replace", async () => {
    await reset();
    const gone = newKey();
    const live = newKey();
    const goneRow = await createPosition({ key: gone });
    await createPosition({ key: live });
    await setSubmitterPositionKeys({ keys: [gone] }, adminId);
    await prisma.position.update({
      where: { id: goneRow.id },
      data: { deletedAt: new Date() },
    });

    await setSubmitterPositionKeys({ keys: [live] }, adminId);

    const rows = await prisma.accessSubmitterPosition.findMany();
    expect(rows.map((row) => row.positionId)).not.toContain(goneRow.id);
    expect(rows).toHaveLength(1);
  });
});
