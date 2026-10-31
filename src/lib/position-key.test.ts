import { describe, expect, it } from "vitest";
import seed from "../../prisma/seed/positions.json";
import {
  KEY_RETIREMENT_DAYS,
  isKeyRetirementActive,
  keyReusableOn,
  positionKeyIssue,
  positionKeySchema,
  positionNameSchema,
  sanitizeKeyInput,
  suggestPositionKey,
} from "@/lib/position-key";

describe("positionKeySchema", () => {
  it.each(["vp-finance", "ab", "a1", "x-y-z", "9-lives", "a".repeat(64)])(
    "accepts %s",
    (key) => {
      expect(positionKeySchema.safeParse(key).success).toBe(true);
    },
  );

  it.each([
    ["uppercase", "VP-Finance"],
    ["too short", "a"],
    ["empty", ""],
    ["leading hyphen", "-x"],
    ["trailing hyphen", "x-"],
    ["double hyphen", "x--y"],
    ["underscore", "vp_finance"],
    ["space", "vp finance"],
    ["surrounding whitespace", " vp-finance "],
    ["too long", "a".repeat(65)],
  ])("rejects %s", (_label, key) => {
    expect(positionKeySchema.safeParse(key).success).toBe(false);
  });

  it("does not trim or lower-case the input", () => {
    const result = positionKeySchema.safeParse(" vp ");
    expect(result.success).toBe(false);
  });
});

describe("positionNameSchema", () => {
  it("trims surrounding whitespace", () => {
    expect(positionNameSchema.parse("  VP Finance  ")).toBe("VP Finance");
  });

  it("accepts the length boundaries", () => {
    expect(positionNameSchema.safeParse("ab").success).toBe(true);
    expect(positionNameSchema.safeParse("a".repeat(100)).success).toBe(true);
  });

  it("rejects names outside the length bounds", () => {
    expect(positionNameSchema.safeParse("a").success).toBe(false);
    expect(positionNameSchema.safeParse("a".repeat(101)).success).toBe(false);
  });

  it("rejects a name that is only whitespace", () => {
    expect(positionNameSchema.safeParse("     ").success).toBe(false);
  });

  it("measures length after trimming", () => {
    expect(positionNameSchema.safeParse(` a${" ".repeat(10)}`).success).toBe(
      false,
    );
  });
});

describe("isKeyRetirementActive", () => {
  const now = new Date("2026-10-14T12:00:00.000Z");
  const daysAgo = (days: number, extraMs = 0) =>
    new Date(now.getTime() - days * 24 * 60 * 60 * 1000 + extraMs);

  it("is active for a key retired just now", () => {
    expect(isKeyRetirementActive(now, now)).toBe(true);
  });

  it("is active for a key retired 100 days ago", () => {
    expect(isKeyRetirementActive(daysAgo(100), now)).toBe(true);
  });

  it("is active one millisecond inside the window", () => {
    expect(isKeyRetirementActive(daysAgo(KEY_RETIREMENT_DAYS, 1), now)).toBe(
      true,
    );
  });

  it("is reusable exactly 365 days after retirement", () => {
    expect(isKeyRetirementActive(daysAgo(KEY_RETIREMENT_DAYS), now)).toBe(
      false,
    );
  });

  it("is reusable 400 days after retirement", () => {
    expect(isKeyRetirementActive(daysAgo(400), now)).toBe(false);
  });
});

describe("keyReusableOn", () => {
  const retiredAt = new Date("2026-10-14T12:00:00.000Z");

  it("is KEY_RETIREMENT_DAYS after retirement", () => {
    expect(keyReusableOn(retiredAt).toISOString()).toBe(
      "2027-10-14T12:00:00.000Z",
    );
  });

  it("matches the boundary of isKeyRetirementActive", () => {
    const reusable = keyReusableOn(retiredAt);
    expect(
      isKeyRetirementActive(retiredAt, new Date(reusable.getTime() - 1)),
    ).toBe(true);
    expect(isKeyRetirementActive(retiredAt, reusable)).toBe(false);
  });
});

describe("suggestPositionKey", () => {
  it.each(seed.positions.map((position) => [position.name, position.key]))(
    "reproduces the seed key for %s",
    (name, key) => {
      expect(suggestPositionKey(name)).toBe(key);
    },
  );

  it.each([
    ["Vice-Chair of Café & Events", "vice-chair-of-cafe-and-events"],
    ["  Spaced   Out  ", "spaced-out"],
    ["Señor Año", "senor-ano"],
    ["--Leading and trailing--", "leading-and-trailing"],
    ["R&D", "r-and-d"],
  ])("suggests a key for %s", (name, key) => {
    expect(suggestPositionKey(name)).toBe(key);
  });

  it.each(["", "a", "!!!", "日本語"])(
    "returns an empty string for %j",
    (name) => {
      expect(suggestPositionKey(name)).toBe("");
    },
  );

  it("truncates to 64 characters without a trailing hyphen", () => {
    const name = `${"a".repeat(63)} bbb`;
    const key = suggestPositionKey(name);
    expect(key).toBe("a".repeat(63));
    expect(key.endsWith("-")).toBe(false);
  });

  it("always produces a key the schema accepts or an empty string", () => {
    for (const name of ["Chair", "x".repeat(200), "A & B & C", "ß-test"]) {
      const key = suggestPositionKey(name);
      expect(key === "" || positionKeySchema.safeParse(key).success).toBe(true);
    }
  });
});

describe("sanitizeKeyInput", () => {
  it("lower-cases ASCII capitals without reporting a rejection", () => {
    expect(sanitizeKeyInput("VP-Finance")).toEqual({
      value: "vp-finance",
      rejected: false,
    });
  });

  it.each([
    ["Ab_c", "abc"],
    ["a b", "ab"],
    ["café", "caf"],
    ["a.b/c", "abc"],
  ])("drops disallowed characters from %s", (raw, value) => {
    expect(sanitizeKeyInput(raw)).toEqual({ value, rejected: true });
  });

  it("keeps hyphens and digits", () => {
    expect(sanitizeKeyInput("a-1--2")).toEqual({
      value: "a-1--2",
      rejected: false,
    });
  });
});

describe("positionKeyIssue", () => {
  it.each([
    ["", "TOO_SHORT"],
    ["a", "TOO_SHORT"],
    ["-", "TOO_SHORT"],
    ["a".repeat(65), "TOO_LONG"],
    ["-x", "EDGE_HYPHEN"],
    ["x-", "EDGE_HYPHEN"],
    ["x--y", "DOUBLE_HYPHEN"],
    ["VP", "INVALID_CHARS"],
    ["a_b", "INVALID_CHARS"],
    ["a b", "INVALID_CHARS"],
  ])("reports %j as %s", (key, issue) => {
    expect(positionKeyIssue(key)).toBe(issue);
  });

  it.each(["vp-finance", "ab", "9-lives", "a".repeat(64)])(
    "accepts %s",
    (key) => {
      expect(positionKeyIssue(key)).toBeNull();
    },
  );

  it("agrees with positionKeySchema on every accept and reject case", () => {
    const cases = [
      "vp-finance",
      "ab",
      "a1",
      "x-y-z",
      "9-lives",
      "a".repeat(64),
      "VP-Finance",
      "a",
      "",
      "-x",
      "x-",
      "x--y",
      "vp_finance",
      "vp finance",
      " vp-finance ",
      "a".repeat(65),
    ];
    for (const key of cases) {
      expect(positionKeyIssue(key) === null).toBe(
        positionKeySchema.safeParse(key).success,
      );
    }
  });
});
