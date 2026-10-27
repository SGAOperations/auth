import { describe, expect, it } from "vitest";
import { displayName, initials } from "@/lib/user-display";

describe("displayName", () => {
  it("prefers the preferred name", () => {
    expect(displayName({ name: "Robert Smith", preferredName: "Bob" })).toBe(
      "Bob",
    );
  });

  it("trims the preferred name", () => {
    expect(
      displayName({ name: "Robert Smith", preferredName: "  Bob  " }),
    ).toBe("Bob");
  });

  it("falls back to the name when the preferred name is empty or blank", () => {
    expect(displayName({ name: "Robert Smith", preferredName: "" })).toBe(
      "Robert Smith",
    );
    expect(displayName({ name: "Robert Smith", preferredName: "   " })).toBe(
      "Robert Smith",
    );
    expect(displayName({ name: "Robert Smith", preferredName: null })).toBe(
      "Robert Smith",
    );
  });
});

describe("initials", () => {
  it("uses one letter for a single word", () => {
    expect(initials("bob")).toBe("B");
  });

  it("uses the first and last words", () => {
    expect(initials("Ada Lovelace")).toBe("AL");
    expect(initials("Mary Jane Watson")).toBe("MW");
  });

  it("ignores extra whitespace", () => {
    expect(initials("  ada   lovelace ")).toBe("AL");
  });

  it("returns a question mark for empty input", () => {
    expect(initials("")).toBe("?");
    expect(initials("   ")).toBe("?");
  });
});
