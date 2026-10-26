import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { Prisma, type PrismaClient } from "@/generated/prisma/client";
import {
  PositionError,
  createPosition,
  toPositionError,
  updatePosition,
  updatePositionInputSchema,
} from "@/lib/positions";

// Shapes observed under @prisma/client 7.10 with adapter-pg, loaded the way the
// app loads the client. Violations are PrismaClientKnownRequestErrors.
function knownError(
  code: string,
  message: string,
  cause: Record<string, unknown>,
) {
  return new Prisma.PrismaClientKnownRequestError(message, {
    code,
    clientVersion: "7.10.0",
    meta: { driverAdapterError: { name: "DriverAdapterError", cause } },
  });
}

// A duplicate active key is P2002 with the index at
// meta.driverAdapterError.cause.constraint.index. There is no meta.target.
function uniqueViolation(index: string) {
  return knownError("P2002", `Unique constraint failed on the \`${index}\``, {
    originalCode: "23505",
    originalMessage: `duplicate key value violates unique constraint "${index}"`,
    kind: "UniqueConstraintViolation",
    constraint: { index },
  });
}

// Check and trigger violations are P2039 and name themselves in `message`.
function checkOrTriggerViolation(originalMessage: string) {
  return knownError(
    "P2039",
    `Database rejected the write: ${originalMessage}`,
    { originalCode: "23514", originalMessage, kind: "postgres" },
  );
}

describe("toPositionError", () => {
  it("returns a PositionError unchanged", () => {
    const err = new PositionError("KEY_RETIRED");
    expect(toPositionError(err)).toBe(err);
  });

  it.each([
    [
      "Position_key_format_check",
      "INVALID_KEY",
      'new row for relation "Position" violates check constraint "Position_key_format_check"',
    ],
    [
      "Position_name_length_check",
      "INVALID_INPUT",
      'new row for relation "Position" violates check constraint "Position_name_length_check"',
    ],
    [
      "KEY_IMMUTABLE",
      "KEY_IMMUTABLE",
      "KEY_IMMUTABLE: position key cannot be changed",
    ],
    [
      "POSITION_LIMIT",
      "POSITION_LIMIT",
      "POSITION_LIMIT: user u1 already holds 50 active positions",
    ],
  ])("maps %s from a P2039", (_name, code, originalMessage) => {
    const err = checkOrTriggerViolation(originalMessage);
    expect(err.code).toBe("P2039");
    expect(toPositionError(err)?.code).toBe(code);
  });

  it("maps a P2002 on the active-key index to KEY_TAKEN", () => {
    const err = uniqueViolation("Position_key_active_key");
    expect(err.meta).not.toHaveProperty("target");
    expect(toPositionError(err)?.code).toBe("KEY_TAKEN");
  });

  it("maps a P2002 whose only signal is the constraint index", () => {
    const err = knownError("P2002", "Unique constraint failed", {
      constraint: { index: "Position_key_active_key" },
    });
    expect(toPositionError(err)?.code).toBe("KEY_TAKEN");
  });

  it("does not map a P2002 on another index", () => {
    expect(toPositionError(uniqueViolation("Position_other_key"))).toBeNull();
  });

  it("maps an error that names the index only on its cause", () => {
    const err = new Error("Invalid `prisma.position.create()` invocation", {
      cause: new Error(
        'duplicate key value violates unique constraint "Position_key_active_key"',
      ),
    });
    expect(toPositionError(err)?.code).toBe("KEY_TAKEN");
  });

  it.each([
    ["an unrelated error", new Error("connection reset")],
    ["a non-error value", "POSITION_LIMIT"],
    ["null", null],
  ])("returns null for %s", (_label, err) => {
    expect(toPositionError(err)).toBeNull();
  });
});

describe("updatePositionInputSchema", () => {
  it("rejects an empty body and an unknown field", () => {
    expect(updatePositionInputSchema.safeParse({}).success).toBe(false);
    expect(
      updatePositionInputSchema.safeParse({ name: "Okay", color: "red" })
        .success,
    ).toBe(false);
  });

  it("turns a blank category or description into null", () => {
    expect(
      updatePositionInputSchema.parse({ category: "  ", description: "" }),
    ).toEqual({ category: null, description: null });
  });

  it("leaves absent fields absent", () => {
    expect(updatePositionInputSchema.parse({ name: " VP Finance " })).toEqual({
      name: "VP Finance",
    });
  });
});

describe("updatePosition key immutability", () => {
  const db = {} as unknown as PrismaClient;

  it.each([
    ["a new key", { key: "other" }],
    ["the unchanged key", { key: "vp-finance", name: "VP Finance" }],
  ])("throws KEY_IMMUTABLE for %s", async (_label, input) => {
    await expect(
      updatePosition("p1", input, null, { db }),
    ).rejects.toMatchObject({ code: "KEY_IMMUTABLE" });
  });

  it("throws INVALID_INPUT for an empty body", async () => {
    await expect(updatePosition("p1", {}, null, { db })).rejects.toMatchObject({
      code: "INVALID_INPUT",
    });
  });
});

describe("createPosition lost race", () => {
  function raceDb(activeAfterRace: boolean) {
    return {
      $transaction: vi
        .fn()
        .mockRejectedValue(uniqueViolation("Position_key_active_key")),
      position: {
        findFirst: vi
          .fn()
          .mockResolvedValue(activeAfterRace ? { id: "p1" } : null),
      },
      retiredPositionKey: { findFirst: vi.fn().mockResolvedValue(null) },
    } as unknown as PrismaClient;
  }

  it("re-checks outside the transaction and reports KEY_TAKEN", async () => {
    const db = raceDb(true);
    await expect(
      createPosition({ key: "vp-finance", name: "VP Finance" }, null, { db }),
    ).rejects.toMatchObject({ code: "KEY_TAKEN" });
    expect(db.position.findFirst).toHaveBeenCalledTimes(1);
  });

  it("still reports KEY_TAKEN when the re-check finds the key free", async () => {
    const db = raceDb(false);
    await expect(
      createPosition({ key: "vp-finance", name: "VP Finance" }, null, { db }),
    ).rejects.toMatchObject({ code: "KEY_TAKEN" });
  });
});
