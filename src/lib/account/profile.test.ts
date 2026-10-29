import { describe, expect, it } from "vitest";
import { profileFieldErrors, profileInputSchema } from "./profile";

describe("profileInputSchema", () => {
  it("trims both names", () => {
    expect(
      profileInputSchema.parse({ name: "  Sam Lee ", preferredName: " Sam " }),
    ).toEqual({ name: "Sam Lee", preferredName: "Sam" });
  });

  it.each([[""], ["   "], [undefined], [null]])(
    "turns a blank preferred name (%j) into null",
    (preferredName) => {
      expect(
        profileInputSchema.parse({ name: "Sam", preferredName }).preferredName,
      ).toBeNull();
    },
  );

  it("requires a name", () => {
    const result = profileInputSchema.safeParse({
      name: "   ",
      preferredName: "",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(profileFieldErrors(result.error)).toEqual({
        name: "Enter your name.",
      });
    }
  });

  it("accepts 100 characters for the name and rejects 101", () => {
    expect(
      profileInputSchema.safeParse({ name: "a".repeat(100) }).success,
    ).toBe(true);
    const result = profileInputSchema.safeParse({ name: "a".repeat(101) });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(profileFieldErrors(result.error).name).toBe(
        "Name must be 100 characters or fewer.",
      );
    }
  });

  it("accepts 50 characters for the preferred name and rejects 51", () => {
    expect(
      profileInputSchema.safeParse({
        name: "Sam",
        preferredName: "a".repeat(50),
      }).success,
    ).toBe(true);
    const result = profileInputSchema.safeParse({
      name: "Sam",
      preferredName: "a".repeat(51),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(profileFieldErrors(result.error).preferredName).toBe(
        "Preferred name must be 50 characters or fewer.",
      );
    }
  });

  it("rejects control characters in either name", () => {
    const result = profileInputSchema.safeParse({
      name: "Sa\u0007m",
      preferredName: "S\nam",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(profileFieldErrors(result.error)).toEqual({
        name: "Names can't contain control characters.",
        preferredName: "Names can't contain control characters.",
      });
    }
  });

  it.each(["email", "image", "id"])("rejects the extra key %s", (key) => {
    expect(
      profileInputSchema.safeParse({
        name: "Sam",
        preferredName: null,
        [key]: "x",
      }).success,
    ).toBe(false);
  });
});
