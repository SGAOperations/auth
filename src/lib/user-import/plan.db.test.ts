import { describe, expect, it } from "vitest";
import { MAX_ACTIVE_POSITIONS_PER_USER } from "@/lib/position-key";
import { prisma } from "@/lib/prisma";
import type { RowErrorCode } from "@/lib/user-import/contract";
import type { ParsedRow } from "@/lib/user-import/csv";
import { buildImportPlan } from "@/lib/user-import/plan";
import { createAdmin, createPosition, createUser } from "@/test/factories";

let counter = 0;
const tag = Math.random().toString(36).slice(2, 8);
const address = (label: string) =>
  `${label}-${(counter += 1)}-${tag}@northeastern.edu`;

function row(
  email: string,
  overrides: Partial<Omit<ParsedRow, "email">> = {},
): ParsedRow {
  return { line: 2, email, name: "Test Person", positions: [], ...overrides };
}

const plan = async (rows: ParsedRow[]) =>
  buildImportPlan(rows, await createAdmin(), { db: prisma });

const codes = (planned: Awaited<ReturnType<typeof plan>>, index = 0) =>
  planned.rows[index]?.row.errors.map((error) => error.code);

async function hold(userId: string, positionIds: string[]) {
  await prisma.userPosition.createMany({
    data: positionIds.map((positionId) => ({ userId, positionId })),
  });
}

describe("buildImportPlan row errors", () => {
  it("INVALID_EMAIL", async () => {
    expect(codes(await plan([row("not-an-email")]))).toEqual(["INVALID_EMAIL"]);
  });

  it("DUPLICATE_EMAIL, naming the first line", async () => {
    const email = address("dup");
    const planned = await plan([
      row(email, { line: 2 }),
      row(email.toUpperCase(), { line: 5 }),
    ]);
    expect(planned.rows[0]?.row.action).toBe("create");
    expect(planned.rows[1]?.row.errors).toEqual([
      { code: "DUPLICATE_EMAIL", message: "Same email as row 2." },
    ]);
  });

  it("NAME_REQUIRED for a new account", async () => {
    expect(codes(await plan([row(address("noname"), { name: "" })]))).toEqual([
      "NAME_REQUIRED",
    ]);
  });

  it("NAME_TOO_LONG for a new account", async () => {
    const planned = await plan([
      row(address("long"), { name: "x".repeat(101) }),
    ]);
    expect(codes(planned)).toEqual(["NAME_TOO_LONG"]);
  });

  it("INVALID_POSITION_KEY, never lower-casing the key", async () => {
    await createPosition({ key: `vp-finance-${tag}` });
    const planned = await plan([
      row(address("badkey"), { positions: [`VP-Finance-${tag}`] }),
    ]);
    expect(codes(planned)).toEqual(["INVALID_POSITION_KEY"]);
  });

  it("UNKNOWN_POSITION", async () => {
    const planned = await plan([
      row(address("unknown"), { positions: [`missing-${tag}`] }),
    ]);
    expect(codes(planned)).toEqual(["UNKNOWN_POSITION"]);
  });

  it("DELETED_POSITION", async () => {
    const gone = await createPosition({ deletedAt: new Date() });
    const planned = await plan([
      row(address("gone"), { positions: [gone.key] }),
    ]);
    expect(codes(planned)).toEqual(["DELETED_POSITION"]);
  });

  it("POSITION_LIMIT for an existing user", async () => {
    const user = await createUser();
    const held = await Promise.all(
      Array.from({ length: MAX_ACTIVE_POSITIONS_PER_USER }, () =>
        createPosition(),
      ),
    );
    await hold(
      user.id,
      held.map((position) => position.id),
    );
    const extra = await createPosition();
    const planned = await plan([row(user.email, { positions: [extra.key] })]);
    expect(codes(planned)).toEqual(["POSITION_LIMIT"]);
    expect(planned.rows[0]?.row.errors[0]?.message).toBe(
      `Would hold ${MAX_ACTIVE_POSITIONS_PER_USER + 1} positions; the limit is ${MAX_ACTIVE_POSITIONS_PER_USER}.`,
    );
  });

  it.each([
    ["DEACTIVATED", "ACCOUNT_DEACTIVATED"],
    ["DELETED", "ACCOUNT_DELETED"],
  ] as const)("%s account is %s", async (status, code: RowErrorCode) => {
    const user = await createUser({ status });
    expect(codes(await plan([row(user.email)]))).toEqual([code]);
  });

  it("NOT_PERMITTED for an actor who is not an admin, on that row only", async () => {
    const outsider = await createUser();
    const planned = await buildImportPlan([row(address("denied"))], outsider, {
      db: prisma,
    });
    expect(codes(planned)).toEqual(["NOT_PERMITTED"]);
  });

  it("collects every error a row has", async () => {
    const planned = await plan([
      row(address("many"), { name: "", positions: ["Bad Key", `none-${tag}`] }),
    ]);
    expect(codes(planned)).toEqual([
      "INVALID_POSITION_KEY",
      "UNKNOWN_POSITION",
      "NAME_REQUIRED",
    ]);
    expect(planned.rows[0]?.row.action).toBe("invalid");
    expect(planned.rows[0]?.row.addPositions).toEqual([]);
  });
});

describe("buildImportPlan classification", () => {
  it("creates a missing account and adds its positions", async () => {
    const position = await createPosition();
    const planned = await plan([
      row(address("new"), { positions: [position.key] }),
    ]);
    expect(planned.rows[0]).toMatchObject({
      userId: null,
      positionIds: [position.id],
      row: { action: "create", addPositions: [position.key], errors: [] },
    });
    expect(planned.summary).toMatchObject({
      rows: 1,
      valid: 1,
      create: 1,
      assignments: 1,
    });
  });

  it("updates an existing user who lacks a position", async () => {
    const user = await createUser();
    const position = await createPosition();
    const planned = await plan([
      row(user.email, { positions: [position.key] }),
    ]);
    expect(planned.rows[0]).toMatchObject({
      userId: user.id,
      row: { action: "update", addPositions: [position.key] },
    });
  });

  it("leaves an existing user unchanged when they hold every position", async () => {
    const user = await createUser();
    const position = await createPosition();
    await hold(user.id, [position.id]);
    const planned = await plan([
      row(user.email, { positions: [position.key] }),
    ]);
    expect(planned.rows[0]?.row).toMatchObject({
      action: "unchanged",
      addPositions: [],
    });
    expect(planned.summary).toMatchObject({ unchanged: 1, assignments: 0 });
  });

  it("matches an existing citext email in any case, and ignores the file's name", async () => {
    const user = await createUser({ name: "Existing Name" });
    const planned = await plan([
      row(` ${user.email.toUpperCase()} `, { name: "Other Name" }),
    ]);
    expect(planned.rows[0]).toMatchObject({
      userId: user.id,
      row: { action: "unchanged", nameDiffers: true },
    });
  });

  it("counts the summary", async () => {
    const planned = await plan([
      row(address("a"), { line: 2 }),
      row("bad", { line: 3 }),
      row((await createUser()).email, { line: 4 }),
    ]);
    expect(planned.summary).toEqual({
      rows: 3,
      valid: 2,
      invalid: 1,
      create: 1,
      update: 0,
      unchanged: 1,
      assignments: 0,
    });
  });
});

describe("buildImportPlan digest", () => {
  it("is stable across runs", async () => {
    const position = await createPosition();
    const rows = [
      row(address("stable"), { positions: [position.key] }),
      row("bad", { line: 3 }),
    ];
    const admin = await createAdmin();
    const first = await buildImportPlan(rows, admin, { db: prisma });
    const second = await buildImportPlan(rows, admin, { db: prisma });
    expect(first.digest).toBe(second.digest);
    expect(first.digest).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when a position is deleted between plans", async () => {
    const position = await createPosition();
    const rows = [row(address("gone"), { positions: [position.key] })];
    const admin = await createAdmin();
    const before = await buildImportPlan(rows, admin, { db: prisma });
    await prisma.position.update({
      where: { id: position.id },
      data: { deletedAt: new Date() },
    });
    const after = await buildImportPlan(rows, admin, { db: prisma });
    expect(after.digest).not.toBe(before.digest);
  });

  it("changes when the user gains the position between plans", async () => {
    const user = await createUser();
    const position = await createPosition();
    const rows = [row(user.email, { positions: [position.key] })];
    const admin = await createAdmin();
    const before = await buildImportPlan(rows, admin, { db: prisma });
    await hold(user.id, [position.id]);
    const after = await buildImportPlan(rows, admin, { db: prisma });
    expect(after.digest).not.toBe(before.digest);
  });
});

describe("buildImportPlan locking", () => {
  it("reads the same plan with the rows locked", async () => {
    const user = await createUser();
    const position = await createPosition();
    const rows = [row(user.email, { positions: [position.key] })];
    const admin = await createAdmin();
    const plain = await buildImportPlan(rows, admin, { db: prisma });
    const locked = await prisma.$transaction((tx) =>
      buildImportPlan(rows, admin, { db: tx, lock: true }),
    );
    expect(locked.digest).toBe(plain.digest);
  });
});
