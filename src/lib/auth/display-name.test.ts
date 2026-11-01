import { describe, expect, it } from "vitest";
import { checkDisplayName } from "@/lib/auth/display-name";

function errorOf(call: () => unknown): unknown {
  try {
    call();
    return null;
  } catch (error) {
    return error;
  }
}

describe("checkDisplayName", () => {
  it.each(["/sign-up/email", "/update-user"])(
    "trims a valid name on %s and keeps the rest of the body",
    (path) => {
      expect(
        checkDisplayName(path, { name: "  Ada Lovelace ", image: null }),
      ).toEqual({ name: "Ada Lovelace", image: null });
    },
  );

  it.each([
    ["a control character", "Ada\r\nBcc: x@example.com"],
    ["more than 100 characters", "n".repeat(101)],
    ["only spaces", "   "],
  ])("refuses a name with %s as 400 INVALID_NAME", (_label, name) => {
    expect(
      errorOf(() => checkDisplayName("/update-user", { name })),
    ).toMatchObject({ statusCode: 400, body: { code: "INVALID_NAME" } });
  });

  it("leaves a body with no string name to the endpoint", () => {
    expect(checkDisplayName("/update-user", { image: "x" })).toBeUndefined();
    expect(checkDisplayName("/sign-up/email", { name: 42 })).toBeUndefined();
  });

  it("ignores every other path", () => {
    expect(
      checkDisplayName("/sign-in/email", { name: "n".repeat(101) }),
    ).toBeUndefined();
    expect(checkDisplayName(undefined, { name: "x" })).toBeUndefined();
  });
});
