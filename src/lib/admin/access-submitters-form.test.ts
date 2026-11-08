import { describe, expect, it } from "vitest";
import { MAX_SUBMITTER_POSITIONS } from "@/lib/access-submitters-input";
import {
  filterOptions,
  groupByCategory,
  toggleKey,
  type SubmitterOption,
} from "./access-submitters-form";

const options: SubmitterOption[] = [
  { key: "president", name: "President", category: "Executive" },
  { key: "vice-president", name: "Vice President", category: "Executive" },
  { key: "web-lead", name: "Web Lead", category: "Technology" },
  { key: "volunteer", name: "Volunteer", category: null },
];

describe("groupByCategory", () => {
  it("groups in input order and maps null to Uncategorized", () => {
    expect(groupByCategory(options)).toEqual([
      ["Executive", [options[0], options[1]]],
      ["Technology", [options[2]]],
      ["Uncategorized", [options[3]]],
    ]);
  });

  it("returns no groups for no options", () => {
    expect(groupByCategory([])).toEqual([]);
  });
});

describe("filterOptions", () => {
  it("returns everything for a blank query", () => {
    expect(filterOptions(options, "  ")).toEqual(options);
  });

  it("matches the name case-insensitively", () => {
    expect(filterOptions(options, " WEB ")).toEqual([options[2]]);
  });

  it("matches the key by substring", () => {
    expect(filterOptions(options, "vice-")).toEqual([options[1]]);
  });

  it("returns nothing when nothing matches", () => {
    expect(filterOptions(options, "zzz")).toEqual([]);
  });
});

describe("toggleKey", () => {
  it("adds a key without mutating the input", () => {
    const selected = ["a"];
    expect(toggleKey(selected, "b", true)).toEqual(["a", "b"]);
    expect(selected).toEqual(["a"]);
  });

  it("removes a key", () => {
    expect(toggleKey(["a", "b"], "a", false)).toEqual(["b"]);
  });

  it("ignores a duplicate add", () => {
    const selected = ["a"];
    expect(toggleKey(selected, "a", true)).toBe(selected);
  });

  it("does not add at the cap but still removes", () => {
    const full = Array.from(
      { length: MAX_SUBMITTER_POSITIONS },
      (_, index) => `key-${index}`,
    );
    expect(toggleKey(full, "extra", true)).toBe(full);
    expect(toggleKey(full, "key-0", false)).toHaveLength(
      MAX_SUBMITTER_POSITIONS - 1,
    );
  });
});
