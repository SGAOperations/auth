import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import {
  POSITION_KEY_MAX,
  POSITION_KEY_MIN,
  POSITION_KEY_PATTERN,
} from "@/lib/position-key";
import {
  CuratedPositionsError,
  applySync,
  formatSummary,
  loadCuratedPositions,
  planSync,
  readExistingPositions,
  type CuratedPosition,
  type ExistingPositions,
} from "./positions";

describe("curated positions.json", () => {
  it("has 83 valid, unique positions", async () => {
    const curated = await loadCuratedPositions();

    expect(curated).toHaveLength(83);
    for (const { key } of curated) {
      expect(key).toMatch(POSITION_KEY_PATTERN);
      expect(key.length).toBeGreaterThanOrEqual(POSITION_KEY_MIN);
      expect(key.length).toBeLessThanOrEqual(POSITION_KEY_MAX);
    }
    expect(new Set(curated.map((p) => p.key)).size).toBe(curated.length);
    expect(new Set(curated.map((p) => p.name)).size).toBe(curated.length);
  });

  it("no longer carries the retired digital-innovation-team-lead key", async () => {
    const curated = await loadCuratedPositions();

    expect(curated.map((p) => p.key)).not.toContain(
      "digital-innovation-team-lead",
    );
  });

  it("is identical in the seed, the design source and the generated copy", async () => {
    const [seed, design, generated] = await Promise.all(
      [
        "../../prisma/seed/positions.json",
        "../../docs/sgauth-design/positions.json",
        "../../docs/sgauth-design/out/positions.json",
      ].map((path) => readFile(new URL(path, import.meta.url), "utf8")),
    );

    expect(design).toBe(seed);
    expect(generated).toBe(seed);
  });
});

describe("loadCuratedPositions rejects bad files", () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "positions-"));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  async function load(positions: unknown[]) {
    const path = join(dir, `${Math.random().toString(36).slice(2)}.json`);
    await writeFile(path, JSON.stringify({ positions }));
    return loadCuratedPositions(path);
  }

  it("rejects a duplicate key", async () => {
    await expect(
      load([
        { key: "vp-finance", name: "Vice President of Finance" },
        { key: "vp-finance", name: "Another Name" },
      ]),
    ).rejects.toThrow(/duplicate key "vp-finance"/);
  });

  it("rejects a duplicate name, ignoring case", async () => {
    await expect(
      load([
        { key: "one-key", name: "Senator" },
        { key: "two-key", name: "senator" },
      ]),
    ).rejects.toThrow(/duplicate name/);
  });

  it("rejects a malformed key and names the entry", async () => {
    const error = await load([
      { key: "VP-Finance", name: "Vice President of Finance" },
    ]).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(CuratedPositionsError);
    expect((error as Error).message).toMatch(
      /positions\[0\] \(key "VP-Finance"\)/,
    );
  });
});

const curated = (
  key: string,
  name: string,
  category?: string,
): CuratedPosition => ({ key, name, category });

const row = (
  key: string,
  name: string,
  category: string | null,
  deletedAt: Date | null = null,
) => ({
  id: `id-${key}-${deletedAt ? "d" : "a"}`,
  key,
  name,
  category,
  deletedAt,
});

const existing = (
  positions: ExistingPositions["positions"],
  retiredKeys: string[] = [],
): ExistingPositions => ({ positions, retiredKeys });

describe("planSync", () => {
  const actions = (plan: ReturnType<typeof planSync>) =>
    plan.map((entry) => entry.action);

  it("creates a key with no row and no retirement", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([]),
    );
    expect(actions(plan)).toEqual(["create"]);
  });

  it("is unchanged when name and category match", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([row("senator", "Senator", "Senate")]),
    );
    expect(actions(plan)).toEqual(["unchanged"]);
  });

  it("updates name drift", () => {
    const [entry] = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([row("senator", "Senator (old)", "Senate")]),
    );
    expect(entry).toMatchObject({
      action: "update",
      change: { name: { from: "Senator (old)", to: "Senator" } },
    });
  });

  it("updates category drift", () => {
    const [entry] = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([row("senator", "Senator", null)]),
    );
    expect(entry).toMatchObject({
      action: "update",
      change: { category: { from: null, to: "Senate" } },
    });
  });

  it("skips a soft-deleted key", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([row("senator", "Senator", "Senate", new Date())]),
    );
    expect(actions(plan)).toEqual(["skip-retired"]);
  });

  it("skips a retired-only key", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([], ["senator"]),
    );
    expect(actions(plan)).toEqual(["skip-retired"]);
  });

  it("updates the active row when a deleted one with the same key also exists", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([
        row("senator", "Old Senator", "Senate", new Date()),
        row("senator", "Senator (old)", "Senate"),
      ]),
    );
    expect(actions(plan)).toEqual(["update"]);
  });

  it("ignores rows that are not curated", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([
        row("senator", "Senator", "Senate"),
        row("aplio-admin", "Aplio Admin", null),
      ]),
    );
    expect(plan).toHaveLength(1);
    expect(actions(plan)).toEqual(["unchanged"]);
  });
});

describe("formatSummary", () => {
  it("prints one line per change, then the counts", () => {
    const plan = planSync(
      [
        curated(
          "vp-finance",
          "Vice President of Finance",
          "Operational Affairs",
        ),
        curated("senator", "Senator", "Senate"),
        curated("old-key", "Old Key", "Senate"),
        curated("treasurer", "Treasurer", "Senate"),
      ],
      existing(
        [
          row("senator", "Senator (old)", "Senate"),
          row("treasurer", "Treasurer", "Senate"),
        ],
        ["old-key"],
      ),
    );

    expect(formatSummary(plan)).toBe(
      [
        '+ create vp-finance "Vice President of Finance" [Operational Affairs]',
        '~ update senator name "Senator (old)" -> "Senator"',
        "! skip   old-key (retired by an admin; not recreated)",
        "4 curated: 1 create, 1 update, 1 unchanged, 1 skipped",
      ].join("\n"),
    );
  });

  it("says so when nothing differs", () => {
    const plan = planSync(
      [curated("senator", "Senator", "Senate")],
      existing([row("senator", "Senator", "Senate")]),
    );
    expect(formatSummary(plan)).toBe(
      "1 curated positions already in sync; nothing to do.",
    );
  });
});

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

describe.skipIf(!url)("applySync against the database", () => {
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });
  // Random suffix: the real curated keys on the shared test branch are never
  // touched.
  const rand = Math.random().toString(36).slice(2, 10);
  const keyA = `sync-a-${rand}`;
  const keyB = `sync-b-${rand}`;
  const keyGone = `sync-gone-${rand}`;
  const fixture = [
    curated(keyA, `Sync A ${rand}`, "Sync Test"),
    curated(keyB, `Sync B ${rand}`, "Sync Test"),
    curated(keyGone, `Sync Gone ${rand}`, "Sync Test"),
  ];

  async function run(list: CuratedPosition[]) {
    const plan = planSync(list, await readExistingPositions(prisma));
    return applySync(prisma, plan);
  }

  afterAll(async () => {
    const keys = [keyA, keyB, keyGone];
    const rows = await prisma.position.findMany({
      where: { key: { in: keys } },
      select: { id: true },
    });
    const ids = rows.map((r) => r.id);
    await prisma.retiredPositionKey.deleteMany({
      where: { positionId: { in: ids } },
    });
    await prisma.position.deleteMany({ where: { id: { in: ids } } });
    await prisma.$disconnect();
  });

  it("creates every row on the first apply", async () => {
    const { counts } = await run(fixture);
    expect(counts).toEqual({ create: 3, update: 0, unchanged: 0, skipped: 0 });

    const rows = await prisma.position.findMany({
      where: { key: { in: [keyA, keyB, keyGone] } },
    });
    expect(rows).toHaveLength(3);
    expect(rows.every((r) => r.createdById === null)).toBe(true);
  });

  it("writes nothing on the second apply", async () => {
    const before = await prisma.position.findUniqueOrThrow({
      where: {
        id: (await prisma.position.findFirstOrThrow({ where: { key: keyA } }))
          .id,
      },
    });
    const { counts } = await run(fixture);
    const after = await prisma.position.findUniqueOrThrow({
      where: { id: before.id },
    });

    expect(counts).toEqual({ create: 0, update: 0, unchanged: 3, skipped: 0 });
    expect(after.updatedAt).toEqual(before.updatedAt);
  });

  it("reverts a manual rename", async () => {
    const target = await prisma.position.findFirstOrThrow({
      where: { key: keyB },
    });
    await prisma.position.update({
      where: { id: target.id },
      data: { name: `Renamed ${rand}` },
    });

    const { counts } = await run(fixture);
    expect(counts.update).toBe(1);
    const after = await prisma.position.findUniqueOrThrow({
      where: { id: target.id },
    });
    expect(after.name).toBe(`Sync B ${rand}`);
  });

  it("skips a soft-deleted key and does not recreate it", async () => {
    const target = await prisma.position.findFirstOrThrow({
      where: { key: keyGone },
    });
    await prisma.$transaction([
      prisma.retiredPositionKey.create({
        data: { positionId: target.id, key: keyGone },
      }),
      prisma.position.update({
        where: { id: target.id },
        data: { deletedAt: new Date() },
      }),
    ]);

    const { counts } = await run(fixture);
    expect(counts.skipped).toBe(1);
    expect(counts.create).toBe(0);
    expect(
      await prisma.position.count({ where: { key: keyGone, deletedAt: null } }),
    ).toBe(0);
  });
});
