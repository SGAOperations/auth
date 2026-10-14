import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/prisma", () => ({ prisma: {} }));

import { PositionError, toPositionError } from "@/lib/positions";

// Shapes observed under @prisma/client 7.6.0 with adapter-pg: no rejection
// carries `code` or `meta`, and the constraint or trigger name is in `message`.
function dbError(message: string): Error {
  return new Error(message);
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
  ])("maps %s from the message", (_label, code, message) => {
    expect(toPositionError(dbError(message))?.code).toBe(code);
  });

  it("maps a unique violation on the active-key index named in the message", () => {
    const err = dbError(
      'duplicate key value violates unique constraint "Position_key_active_key"',
    );
    expect(toPositionError(err)?.code).toBe("KEY_TAKEN");
  });

  it("maps a unique violation named only on the cause", () => {
    const err = new Error("Invalid `prisma.position.create()` invocation", {
      cause: dbError(
        'duplicate key value violates unique constraint "Position_key_active_key"',
      ),
    });
    expect(toPositionError(err)?.code).toBe("KEY_TAKEN");
  });

  it("does not map the Prisma ReferenceError, which names nothing", () => {
    const err = new ReferenceError(
      "Must call super constructor in derived class before accessing 'this' or returning from derived constructor",
    );
    expect(toPositionError(err)).toBeNull();
  });

  it.each([
    ["an unrelated error", new Error("connection reset")],
    ["a non-error value", "POSITION_LIMIT"],
    ["null", null],
  ])("returns null for %s", (_label, err) => {
    expect(toPositionError(err)).toBeNull();
  });
});
