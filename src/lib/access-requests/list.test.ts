import { describe, expect, it } from "vitest";
import { encodeCursor } from "@/lib/audit-log";
import { accessRequestPageSchema } from "@/lib/access-requests/list";

const cursor = {
  createdAt: new Date("2026-11-07T19:03:00.000Z"),
  id: "0192f3a4-5b6c-7d8e-9f01-23456789abcd",
};

describe("accessRequestPageSchema", () => {
  it("accepts no cursor", () => {
    expect(accessRequestPageSchema.parse({})).toEqual({ cursor: undefined });
  });

  it("treats an empty cursor as absent", () => {
    expect(accessRequestPageSchema.parse({ cursor: "" })).toEqual({
      cursor: undefined,
    });
  });

  it("decodes a valid cursor", () => {
    expect(
      accessRequestPageSchema.parse({ cursor: encodeCursor(cursor) }),
    ).toEqual({ cursor });
  });

  it("ignores other params", () => {
    expect(accessRequestPageSchema.parse({ other: "x" })).toEqual({
      cursor: undefined,
    });
  });

  it("rejects a garbage cursor", () => {
    expect(
      accessRequestPageSchema.safeParse({ cursor: "nonsense" }).success,
    ).toBe(false);
    expect(accessRequestPageSchema.safeParse({ cursor: "!!" }).success).toBe(
      false,
    );
  });

  it("rejects a cursor over 200 characters", () => {
    expect(
      accessRequestPageSchema.safeParse({ cursor: "a".repeat(201) }).success,
    ).toBe(false);
  });

  it("rejects an array value", () => {
    expect(
      accessRequestPageSchema.safeParse({
        cursor: [encodeCursor(cursor), encodeCursor(cursor)],
      }).success,
    ).toBe(false);
  });
});
