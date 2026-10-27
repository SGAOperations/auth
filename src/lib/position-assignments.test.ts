import { describe, expect, it, vi } from "vitest";

vi.mock("@/lib/auth/server", () => ({ getSession: vi.fn() }));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/rate-limit/server", () => ({ limitRequest: vi.fn() }));

import {
  AssignmentError,
  assignPositionToUsersInputSchema,
  assignmentErrorResponse,
  updateUserPositionsInputSchema,
  type AssignmentErrorCode,
} from "@/lib/position-assignments";

const uuids = (count: number) =>
  Array.from(
    { length: count },
    (_, i) => `00000000-0000-4000-8000-${String(i).padStart(12, "0")}`,
  );

describe("updateUserPositionsInputSchema", () => {
  const [a, b] = uuids(2);

  it.each([[{}], [{ assign: [], unassign: [] }]])(
    "rejects %j, which changes nothing",
    (input) => {
      expect(updateUserPositionsInputSchema.safeParse(input).success).toBe(
        false,
      );
    },
  );

  it("rejects an id in both lists on the unassign path", () => {
    const result = updateUserPositionsInputSchema.safeParse({
      assign: [a],
      unassign: [a],
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0]?.path).toEqual(["unassign"]);
  });

  it("rejects 51 ids, a non-uuid and an unknown key", () => {
    const parse = (input: unknown) =>
      updateUserPositionsInputSchema.safeParse(input).success;
    expect(parse({ assign: uuids(51) })).toBe(false);
    expect(parse({ assign: ["nope"] })).toBe(false);
    expect(parse({ assign: [a], add: [b] })).toBe(false);
    expect(parse({ assign: uuids(50) })).toBe(true);
  });

  it("collapses duplicates and defaults the missing list", () => {
    expect(updateUserPositionsInputSchema.parse({ assign: [a, b, a] })).toEqual(
      { assign: [a, b], unassign: [] },
    );
  });
});

describe("assignPositionToUsersInputSchema", () => {
  it("rejects zero and 201 ids and accepts 200", () => {
    const parse = (userIds: string[]) =>
      assignPositionToUsersInputSchema.safeParse({ userIds }).success;
    expect(parse([])).toBe(false);
    expect(parse(uuids(201))).toBe(false);
    expect(parse(uuids(200))).toBe(true);
  });

  it("collapses duplicates", () => {
    const [a] = uuids(1);
    expect(
      assignPositionToUsersInputSchema.parse({ userIds: [a, a] }).userIds,
    ).toEqual([a]);
  });
});

describe("assignmentErrorResponse", () => {
  const STATUS: Record<AssignmentErrorCode, number> = {
    INVALID_INPUT: 400,
    FORBIDDEN: 403,
    USER_NOT_FOUND: 404,
    POSITION_NOT_FOUND: 404,
    USER_DELETED: 409,
    POSITION_DELETED: 409,
    POSITION_LIMIT: 409,
  };

  it.each(Object.entries(STATUS))(
    "maps %s to %i with its details and no-store",
    async (code, status) => {
      const response = assignmentErrorResponse(
        new AssignmentError(code as AssignmentErrorCode, {
          userIds: ["u1"],
          positionIds: ["p1"],
          reason: "NOT_ADMIN",
        }),
      );
      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(await response.json()).toMatchObject({
        code,
        userIds: ["u1"],
        positionIds: ["p1"],
        reason: "NOT_ADMIN",
      });
    },
  );
});
