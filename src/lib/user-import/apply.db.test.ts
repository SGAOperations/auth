import { describe, expect, it } from "vitest";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";
import { prisma } from "@/lib/prisma";
import { applyImportPlan, ImportError } from "@/lib/user-import/apply";
import type { ParsedRow } from "@/lib/user-import/csv";
import { buildImportPlan, type ImportPlan } from "@/lib/user-import/plan";
import { createAdmin, createPosition, createUser } from "@/test/factories";

let counter = 0;
const tag = Math.random().toString(36).slice(2, 8);
const address = () => `import-${(counter += 1)}-${tag}@northeastern.edu`;

const row = (
  email: string,
  positions: string[] = [],
  line = counter + 2,
): ParsedRow => ({ line, email, name: "Test Person", positions });

type Admin = Awaited<ReturnType<typeof createAdmin>>;

const planOf = (rows: ParsedRow[], admin: Admin) =>
  prisma.$transaction((tx) => buildImportPlan(rows, admin, { db: tx }));

const run = (plan: ImportPlan, admin: Admin, skipInvalid = false) =>
  prisma.$transaction((tx) =>
    applyImportPlan(plan, { tx, actorId: admin.id, skipInvalid }),
  );

/** Plans and applies in one transaction, as the apply route does. */
const planAndRun = (rows: ParsedRow[], admin: Admin, skipInvalid = false) =>
  prisma.$transaction(async (tx) => {
    const plan = await buildImportPlan(rows, admin, { db: tx, lock: true });
    return applyImportPlan(plan, { tx, actorId: admin.id, skipInvalid });
  });

const imported = () => ({ email: { contains: tag } });

describe("applyImportPlan", () => {
  it("imports nothing from a file with invalid rows, unless told to skip them", async () => {
    const admin = await createAdmin();
    const rows = Array.from({ length: 200 }, (_, n) =>
      row(n < 5 ? `bad-${n}` : address(), [], n + 2),
    );

    await expect(planAndRun(rows, admin)).rejects.toMatchObject({
      code: "INVALID_ROWS",
    });
    expect(await prisma.user.count({ where: imported() })).toBe(0);

    const applied = await planAndRun(rows, admin, true);
    expect(applied.createdUsers).toHaveLength(195);
    expect(applied.rows.filter((r) => r.result === "skipped")).toHaveLength(5);
    expect(await prisma.user.count({ where: imported() })).toBe(195);
  });

  it("creates password-less, verified, active accounts with their positions", async () => {
    const admin = await createAdmin();
    const [a, b] = await Promise.all([createPosition(), createPosition()]);
    const email = address();
    const applied = await planAndRun(
      [row(email, [a.key, b.key]), row(address())],
      admin,
    );

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
      include: { accounts: true, positions: true },
    });
    expect(user).toMatchObject({
      emailVerified: true,
      status: "ACTIVE",
      isAdmin: false,
    });
    expect(user.accounts).toEqual([]);
    expect(user.positions.map((p) => p.positionId).sort()).toEqual(
      [a.id, b.id].sort(),
    );
    expect(user.positions.every((p) => p.assignedById === admin.id)).toBe(true);
    expect(applied.insertedPairs).toHaveLength(2);
    expect(applied.rows.map((r) => r.result)).toEqual(["created", "created"]);
  });

  it("is idempotent: the same file again creates and assigns nothing", async () => {
    const admin = await createAdmin();
    const position = await createPosition();
    const rows = [
      row(address(), [position.key]),
      row(address(), [position.key]),
      row(address()),
    ];

    const first = await planAndRun(rows, admin);
    expect(first.createdUsers).toHaveLength(3);
    expect(first.insertedPairs).toHaveLength(2);

    const second = await planAndRun(rows, admin);
    expect(second.createdUsers).toEqual([]);
    expect(second.insertedPairs).toEqual([]);
    expect(second.rows.map((r) => r.result)).toEqual([
      "unchanged",
      "unchanged",
      "unchanged",
    ]);
    expect(
      await prisma.userPosition.count({ where: { positionId: position.id } }),
    ).toBe(2);
  });

  it("adds a position to an existing user and keeps their name", async () => {
    const admin = await createAdmin();
    const user = await createUser({ name: "Kept Name" });
    const position = await createPosition();
    const applied = await planAndRun(
      [
        {
          line: 2,
          email: user.email,
          name: "Changed",
          positions: [position.key],
        },
      ],
      admin,
    );
    expect(applied.rows[0]).toMatchObject({
      result: "updated",
      userId: user.id,
    });
    expect(applied.createdUsers).toEqual([]);
    expect(
      (await prisma.user.findUniqueOrThrow({ where: { id: user.id } })).name,
    ).toBe("Kept Name");
  });

  it("reports only the pairs it inserted when one was added after the plan", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const position = await createPosition();
    const plan = await planOf([row(user.email, [position.key])], admin);
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: position.id },
    });
    const applied = await run(plan, admin);
    expect(applied.insertedPairs).toEqual([]);
  });

  it("refuses a plan that would exceed the cap, and the trigger backs it up", async () => {
    const admin = await createAdmin();
    const user = await createUser();
    const held = await Promise.all(
      Array.from({ length: MAX_ACTIVE_POSITIONS_PER_USER - 1 }, () =>
        createPosition(),
      ),
    );
    await prisma.userPosition.createMany({
      data: held.map((p) => ({ userId: user.id, positionId: p.id })),
    });
    const [one, two] = await Promise.all([createPosition(), createPosition()]);

    // The plan's own check.
    const over = await planOf([row(user.email, [one.key, two.key])], admin);
    expect(over.rows[0]?.row.errors.map((e) => e.code)).toEqual([
      "POSITION_LIMIT",
    ]);

    // A plan made while there was room, applied after a race filled it.
    const fits = await planOf([row(user.email, [one.key])], admin);
    await prisma.userPosition.create({
      data: { userId: user.id, positionId: two.id },
    });
    await expect(run(fits, admin)).rejects.toMatchObject({
      code: "POSITION_LIMIT",
    });
    expect(
      await prisma.userPosition.count({ where: { positionId: one.id } }),
    ).toBe(0);
  });

  it("rolls everything back on a conflicting creation", async () => {
    const admin = await createAdmin();
    const first = address();
    const racing = address();
    const plan = await planOf([row(first), row(racing)], admin);
    await createUser({ email: racing });

    const error = await run(plan, admin).catch((err: unknown) => err);
    expect(error).toBeInstanceOf(ImportError);
    expect(error).toMatchObject({ code: "CONFLICT" });
    expect(await prisma.user.count({ where: { email: first } })).toBe(0);
  });
});
