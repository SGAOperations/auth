import { readFile } from "node:fs/promises";
import { z } from "zod";
import type { Prisma, PrismaClient } from "../../src/generated/prisma/index.js";
import {
  positionKeySchema,
  positionNameSchema,
} from "../../src/lib/position-key";

// Standalone module shared by prisma/seed.ts and scripts/positions-sync.ts. It
// takes its client as an argument: src/lib/positions.ts is `server-only` and
// bound to the app singleton, so scripts cannot load it.

const curatedPositionSchema = z.object({
  key: positionKeySchema,
  name: positionNameSchema,
  category: z.string().trim().min(1).max(100).optional(),
});

const curatedFileSchema = z.object({
  positions: z.array(z.unknown()),
});

export type CuratedPosition = z.infer<typeof curatedPositionSchema>;

export type ExistingPositions = {
  /** Every Position row, active and soft-deleted. */
  positions: Array<{
    id: string;
    key: string;
    name: string;
    category: string | null;
    deletedAt: Date | null;
  }>;
  /** Every RetiredPositionKey.key. */
  retiredKeys: string[];
};

type Change = {
  name?: { from: string; to: string };
  category?: { from: string | null; to: string | null };
};

export type PlanEntry =
  | { action: "create"; curated: CuratedPosition }
  | { action: "update"; curated: CuratedPosition; id: string; change: Change }
  | { action: "unchanged"; curated: CuratedPosition }
  | { action: "skip-retired"; curated: CuratedPosition };

export type SyncCounts = {
  create: number;
  update: number;
  unchanged: number;
  skipped: number;
};

export class CuratedPositionsError extends Error {}

/** Another writer created a curated key between the read and the write. */
export class SyncConflictError extends Error {}

export async function loadCuratedPositions(
  path: URL | string = new URL("./positions.json", import.meta.url),
): Promise<CuratedPosition[]> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, "utf8"));
  } catch (error) {
    throw new CuratedPositionsError(
      `Cannot read curated positions: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const file = curatedFileSchema.safeParse(raw);
  if (!file.success) {
    throw new CuratedPositionsError(
      `Invalid curated positions file: ${z.prettifyError(file.error)}`,
    );
  }

  const problems: string[] = [];
  const curated: CuratedPosition[] = [];
  file.data.positions.forEach((entry, index) => {
    const parsed = curatedPositionSchema.safeParse(entry);
    if (parsed.success) {
      curated.push(parsed.data);
      return;
    }
    const key =
      typeof entry === "object" && entry !== null && "key" in entry
        ? JSON.stringify(entry.key)
        : "?";
    problems.push(
      `positions[${index}] (key ${key}): ${parsed.error.issues
        .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
        .join("; ")}`,
    );
  });

  const keys = new Set<string>();
  const names = new Map<string, string>();
  for (const { key, name } of curated) {
    if (keys.has(key)) problems.push(`duplicate key "${key}"`);
    keys.add(key);
    const folded = name.toLowerCase();
    const other = names.get(folded);
    if (other !== undefined) {
      problems.push(
        `duplicate name "${name}" (keys "${other}" and "${key}", compared case-insensitively)`,
      );
    } else {
      names.set(folded, key);
    }
  }

  if (problems.length > 0) {
    throw new CuratedPositionsError(
      `Curated positions are invalid:\n${problems.map((p) => `  - ${p}`).join("\n")}`,
    );
  }
  return curated;
}

type Reader = Pick<Prisma.TransactionClient, "position" | "retiredPositionKey">;

export async function readExistingPositions(
  db: Reader,
): Promise<ExistingPositions> {
  const [positions, retired] = await Promise.all([
    db.position.findMany({
      select: {
        id: true,
        key: true,
        name: true,
        category: true,
        deletedAt: true,
      },
    }),
    db.retiredPositionKey.findMany({ select: { key: true } }),
  ]);
  return { positions, retiredKeys: retired.map((row) => row.key) };
}

export function planSync(
  curated: CuratedPosition[],
  existing: ExistingPositions,
): PlanEntry[] {
  const active = new Map<string, ExistingPositions["positions"][number]>();
  const everKnown = new Set(existing.retiredKeys);
  for (const row of existing.positions) {
    everKnown.add(row.key);
    if (row.deletedAt === null) active.set(row.key, row);
  }

  return curated.map((entry): PlanEntry => {
    const row = active.get(entry.key);
    if (row === undefined) {
      return everKnown.has(entry.key)
        ? { action: "skip-retired", curated: entry }
        : { action: "create", curated: entry };
    }
    const change: Change = {};
    if (row.name !== entry.name) {
      change.name = { from: row.name, to: entry.name };
    }
    const category = entry.category ?? null;
    if (row.category !== category) {
      change.category = { from: row.category, to: category };
    }
    return Object.keys(change).length > 0
      ? { action: "update", curated: entry, id: row.id, change }
      : { action: "unchanged", curated: entry };
  });
}

export function countPlan(plan: PlanEntry[]): SyncCounts {
  const counts: SyncCounts = { create: 0, update: 0, unchanged: 0, skipped: 0 };
  for (const entry of plan) {
    if (entry.action === "skip-retired") counts.skipped += 1;
    else counts[entry.action] += 1;
  }
  return counts;
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "P2002"
  );
}

/**
 * Writes the plan in one transaction. The plan is recomputed from a re-read
 * inside the transaction, which narrows the window for overwriting a
 * concurrent admin edit but does not close it: the transaction runs at READ
 * COMMITTED with no row locks. Returns the plan that was actually applied.
 */
export async function applySync(
  db: PrismaClient,
  plan: PlanEntry[],
): Promise<{ plan: PlanEntry[]; counts: SyncCounts }> {
  const curated = plan.map((entry) => entry.curated);
  try {
    return await db.$transaction(
      async (tx) => {
        const fresh = planSync(curated, await readExistingPositions(tx));
        for (const entry of fresh) {
          if (entry.action === "create") {
            await tx.position.create({
              data: {
                key: entry.curated.key,
                name: entry.curated.name,
                category: entry.curated.category ?? null,
                createdById: null,
                updatedById: null,
              },
            });
          } else if (entry.action === "update") {
            await tx.position.update({
              where: { id: entry.id },
              data: {
                name: entry.curated.name,
                category: entry.curated.category ?? null,
              },
            });
          }
        }
        return { plan: fresh, counts: countPlan(fresh) };
      },
      // The first production apply is ~82 sequential round trips to Neon, well
      // past Prisma's 5 s default; a timeout would roll the whole apply back.
      { timeout: 120_000, maxWait: 15_000 },
    );
  } catch (error) {
    if (isUniqueViolation(error)) {
      throw new SyncConflictError(
        "Another writer created a curated key; re-run.",
      );
    }
    throw error;
  }
}

function describeChange(change: Change): string {
  const show = (value: string | null) =>
    value === null ? "(none)" : `"${value}"`;
  const parts: string[] = [];
  if (change.name) {
    parts.push(`name ${show(change.name.from)} -> ${show(change.name.to)}`);
  }
  if (change.category) {
    parts.push(
      `category ${show(change.category.from)} -> ${show(change.category.to)}`,
    );
  }
  return parts.join(", ");
}

export function formatSummary(plan: PlanEntry[]): string {
  const lines: string[] = [];
  for (const entry of plan) {
    const { key, name, category } = entry.curated;
    if (entry.action === "create") {
      lines.push(
        `+ create ${key} "${name}"${category ? ` [${category}]` : ""}`,
      );
    } else if (entry.action === "update") {
      lines.push(`~ update ${key} ${describeChange(entry.change)}`);
    } else if (entry.action === "skip-retired") {
      lines.push(`! skip   ${key} (retired by an admin; not recreated)`);
    }
  }

  const counts = countPlan(plan);
  if (lines.length === 0) {
    lines.push(
      `${plan.length} curated positions already in sync; nothing to do.`,
    );
  } else {
    lines.push(
      `${plan.length} curated: ${counts.create} create, ${counts.update} update, ${counts.unchanged} unchanged, ${counts.skipped} skipped`,
    );
  }
  return lines.join("\n");
}
