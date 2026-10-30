import { describe, expect, it } from "vitest";
import { prisma } from "@/lib/prisma";
import {
  PositionError,
  createPosition as createPositionService,
  deletePosition,
  getManagerChain,
  listLeadershipPositions,
  loadPositionGraph,
  updatePosition,
} from "@/lib/positions";
import { createPosition } from "@/test/factories";

const rand = Math.random().toString(36).slice(2, 8);
let counter = 0;
const key = () => `t290-${rand}-${(counter += 1)}`;

async function codeOf(promise: Promise<unknown>) {
  try {
    await promise;
  } catch (err) {
    if (err instanceof PositionError) return err.code;
    throw err;
  }
  return null;
}

const managerOf = async (id: string) =>
  (await prisma.position.findUniqueOrThrow({ where: { id } }))
    .managerPositionId;

describe("position_manager_valid trigger and Position_manager_not_self_check", () => {
  it("refuses a self-manager with the not-self CHECK", async () => {
    const position = await createPosition();
    await expect(
      prisma.position.update({
        where: { id: position.id },
        data: { managerPositionId: position.id },
      }),
    ).rejects.toThrow(/Position_manager_not_self_check/);
  });

  it("refuses a loop, however deep", async () => {
    const a = await createPosition();
    const b = await createPosition({ managerPositionId: a.id });
    const c = await createPosition({ managerPositionId: b.id });
    await expect(
      prisma.position.update({
        where: { id: a.id },
        data: { managerPositionId: c.id },
      }),
    ).rejects.toThrow(/MANAGER_CYCLE/);
    expect(await managerOf(a.id)).toBeNull();
  });

  it("refuses a missing or deleted manager on insert and update", async () => {
    const deleted = await createPosition({ deletedAt: new Date() });
    await expect(
      createPosition({ managerPositionId: deleted.id }),
    ).rejects.toThrow(/MANAGER_NOT_FOUND/);

    const position = await createPosition();
    await expect(
      prisma.position.update({
        where: { id: position.id },
        data: { managerPositionId: deleted.id },
      }),
    ).rejects.toThrow(/MANAGER_NOT_FOUND/);
  });

  it("accepts a valid re-parent", async () => {
    const a = await createPosition();
    const b = await createPosition({ managerPositionId: a.id });
    const c = await createPosition();
    await prisma.position.update({
      where: { id: b.id },
      data: { managerPositionId: c.id },
    });
    expect(await managerOf(b.id)).toBe(c.id);
  });

  it("sets a report's manager to null when the manager row is hard-deleted", async () => {
    const boss = await createPosition();
    const report = await createPosition({ managerPositionId: boss.id });
    await prisma.position.delete({ where: { id: boss.id } });
    expect(await managerOf(report.id)).toBeNull();
  });
});

describe("position service manager rules", () => {
  it("creates with leadership and a manager", async () => {
    const boss = await createPosition();
    const created = await createPositionService(
      {
        key: key(),
        name: "Reports Up",
        isLeadership: true,
        managerPositionId: boss.id,
      },
      null,
    );
    expect(created).toMatchObject({
      isLeadership: true,
      managerPositionId: boss.id,
    });
  });

  it("reports MANAGER_NOT_FOUND and MANAGER_CYCLE before the database does", async () => {
    const deleted = await createPosition({ deletedAt: new Date() });
    expect(
      await codeOf(
        createPositionService(
          { key: key(), name: "Orphan", managerPositionId: deleted.id },
          null,
        ),
      ),
    ).toBe("MANAGER_NOT_FOUND");

    const top = await createPosition();
    const below = await createPosition({ managerPositionId: top.id });
    expect(
      await codeOf(
        updatePosition(top.id, { managerPositionId: below.id }, null),
      ),
    ).toBe("MANAGER_CYCLE");
    expect(
      await codeOf(updatePosition(top.id, { managerPositionId: top.id }, null)),
    ).toBe("MANAGER_CYCLE");
    expect(await managerOf(top.id)).toBeNull();
  });

  it("diffs leadership and manager into before and after", async () => {
    const boss = await createPosition();
    const position = await createPosition();
    const result = await updatePosition(
      position.id,
      { isLeadership: true, managerPositionId: boss.id, name: position.name },
      null,
    );
    expect(result.changed).toBe(true);
    expect(result.before).toEqual({
      isLeadership: false,
      managerPositionId: null,
    });
    expect(result.after).toEqual({
      isLeadership: true,
      managerPositionId: boss.id,
    });

    const again = await updatePosition(
      position.id,
      { isLeadership: true, managerPositionId: boss.id },
      null,
    );
    expect(again.changed).toBe(false);
  });

  it("clears the manager with null", async () => {
    const boss = await createPosition();
    const position = await createPosition({ managerPositionId: boss.id });
    const result = await updatePosition(
      position.id,
      { managerPositionId: null },
      null,
    );
    expect(result.after).toEqual({ managerPositionId: null });
    expect(await managerOf(position.id)).toBeNull();
  });

  it("clears the reports' manager when the manager is deleted", async () => {
    const boss = await createPosition();
    const r1 = await createPosition({ managerPositionId: boss.id });
    const r2 = await createPosition({ managerPositionId: boss.id });
    const result = await deletePosition(boss.id, boss.key, null);
    expect(result.reportIds).toEqual([r1.id, r2.id].sort());
    expect(await managerOf(r1.id)).toBeNull();
    expect(await managerOf(r2.id)).toBeNull();
  });
});

describe("position read helpers", () => {
  it("lists active leadership positions and walks the manager chain", async () => {
    const category = `t290-${rand}-cat`;
    const root = await createPosition({ category, isLeadership: true });
    const middle = await createPosition({
      category,
      isLeadership: true,
      managerPositionId: root.id,
    });
    const leaf = await createPosition({
      category,
      managerPositionId: middle.id,
    });
    const deletedLeader = await createPosition({
      category,
      isLeadership: true,
      deletedAt: new Date(),
    });

    const leaders = (await listLeadershipPositions()).map((p) => p.id);
    expect(leaders).toContain(root.id);
    expect(leaders).toContain(middle.id);
    expect(leaders).not.toContain(leaf.id);
    expect(leaders).not.toContain(deletedLeader.id);

    const graph = await loadPositionGraph();
    expect(graph.find((p) => p.id === leaf.id)).toMatchObject({
      managerPositionId: middle.id,
      isLeadership: false,
    });
    expect(graph.some((p) => p.id === deletedLeader.id)).toBe(false);

    expect((await getManagerChain(leaf.id))?.map((p) => p.id)).toEqual([
      middle.id,
      root.id,
    ]);
    expect(await getManagerChain(root.id)).toEqual([]);
    expect(await getManagerChain(deletedLeader.id)).toBeNull();
    expect(
      await getManagerChain("0194f4a4-6b1e-7c3a-9d52-3f8a1b2c4d5e"),
    ).toBeNull();
  });
});
