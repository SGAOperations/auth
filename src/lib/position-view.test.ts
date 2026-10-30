import { describe, expect, it } from "vitest";
import {
  GENERIC_ERROR_MESSAGE,
  UNCATEGORIZED,
  formatPositionDate,
  groupPositionsByCategory,
  isKeyErrorCode,
  positionErrorMessage,
  positionFailureToast,
} from "@/lib/position-view";

describe("groupPositionsByCategory", () => {
  const rows = [
    { name: "Webmaster", category: "Operational Affairs" },
    { name: "Senator", category: "Senate" },
    { name: "Loose", category: null },
    { name: "Comptroller", category: "Operational Affairs" },
    { name: "Academic", category: "Academic Affairs" },
    { name: "Another", category: null },
  ];

  it("sorts categories by name with Uncategorized last", () => {
    expect(groupPositionsByCategory(rows).map((g) => g.category)).toEqual([
      "Academic Affairs",
      "Operational Affairs",
      "Senate",
      UNCATEGORIZED,
    ]);
  });

  it("sorts rows inside a group by name", () => {
    const groups = groupPositionsByCategory(rows);
    expect(groups[1].positions.map((p) => p.name)).toEqual([
      "Comptroller",
      "Webmaster",
    ]);
    expect(groups[3].positions.map((p) => p.name)).toEqual([
      "Another",
      "Loose",
    ]);
  });

  it("returns no groups for no rows", () => {
    expect(groupPositionsByCategory([])).toEqual([]);
  });

  it("omits Uncategorized when every row has a category", () => {
    const groups = groupPositionsByCategory([{ name: "A", category: "X" }]);
    expect(groups.map((g) => g.category)).toEqual(["X"]);
  });
});

describe("positionErrorMessage", () => {
  it("has copy for the key errors", () => {
    expect(positionErrorMessage("KEY_TAKEN")).toBe(
      "Another active position already uses this key.",
    );
    expect(positionErrorMessage("KEY_RETIRED")).toContain("365 days");
  });

  it("has copy for a position that is gone", () => {
    expect(positionErrorMessage("POSITION_NOT_FOUND")).toBe(
      "This position no longer exists.",
    );
  });

  it("falls back to the generic message for an unknown code", () => {
    expect(positionErrorMessage("NOPE")).toBe(GENERIC_ERROR_MESSAGE);
    expect(positionErrorMessage("NETWORK")).toBe(GENERIC_ERROR_MESSAGE);
  });
});

describe("positionFailureToast", () => {
  it("ends a lapsed session with a refresh", () => {
    expect(
      positionFailureToast({ status: 401, code: "UNAUTHENTICATED" }),
    ).toEqual({
      message: "Your session has ended. Sign in again.",
      refresh: true,
    });
  });

  it("reports lost admin access without a refresh", () => {
    expect(positionFailureToast({ status: 403, code: "FORBIDDEN" })).toEqual({
      message: "You no longer have admin access.",
      refresh: false,
    });
  });

  it.each([
    { status: 404, code: "POSITION_NOT_FOUND" },
    { status: 409, code: "POSITION_DELETED" },
    { status: 404, code: "UNKNOWN" },
  ])("treats $status $code as a position that is gone", (failure) => {
    expect(positionFailureToast(failure)).toEqual({
      message: "This position no longer exists.",
      refresh: true,
    });
  });

  it("shows the generic message for a server error or a network failure", () => {
    const generic = { message: GENERIC_ERROR_MESSAGE, refresh: false };
    expect(positionFailureToast({ status: 500, code: "UNKNOWN" })).toEqual(
      generic,
    );
    expect(positionFailureToast({ status: 0, code: "NETWORK" })).toEqual(
      generic,
    );
  });

  it("uses the copy for a known code", () => {
    expect(
      positionFailureToast({ status: 400, code: "CONFIRM_KEY_MISMATCH" })
        .message,
    ).toBe("The key you typed doesn't match.");
  });
});

describe("isKeyErrorCode", () => {
  it("is true only for the key codes", () => {
    expect(isKeyErrorCode("KEY_TAKEN")).toBe(true);
    expect(isKeyErrorCode("KEY_RETIRED")).toBe(true);
    expect(isKeyErrorCode("INVALID_KEY")).toBe(true);
    expect(isKeyErrorCode("INVALID_INPUT")).toBe(false);
  });
});

describe("formatPositionDate", () => {
  it("formats in New York time", () => {
    expect(formatPositionDate(new Date("2026-10-14T12:00:00.000Z"))).toBe(
      "Oct 14, 2026",
    );
  });

  it("uses the New York calendar day near midnight UTC", () => {
    expect(formatPositionDate(new Date("2026-10-15T02:00:00.000Z"))).toBe(
      "Oct 14, 2026",
    );
  });
});
