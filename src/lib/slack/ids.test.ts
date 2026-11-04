import { describe, expect, it } from "vitest";
import {
  slackChannelIdSchema,
  slackTeamIdSchema,
  slackUserIdSchema,
} from "./ids";

const ok =
  (schema: { safeParse: (v: unknown) => { success: boolean } }) =>
  (value: string) =>
    schema.safeParse(value).success;

describe("slackTeamIdSchema", () => {
  const accepts = ok(slackTeamIdSchema);

  it("accepts T ids", () => {
    expect(accepts("T012AB3C4")).toBe(true);
    expect(accepts("T0A")).toBe(true);
  });

  it("rejects other prefixes, case, length and padding", () => {
    for (const id of [
      "E012AB3C4",
      "t012ab3c4",
      "T1",
      `T${"A".repeat(21)}`,
      " T012AB3C4",
      "T012AB3C4 ",
    ]) {
      expect(accepts(id), id).toBe(false);
    }
  });
});

describe("slackUserIdSchema", () => {
  const accepts = ok(slackUserIdSchema);

  it("accepts U and W ids and rejects channels", () => {
    expect(accepts("U012AB3C4")).toBe(true);
    expect(accepts("W012AB3C4")).toBe(true);
    expect(accepts("C012AB3C4")).toBe(false);
  });
});

describe("slackChannelIdSchema", () => {
  const accepts = ok(slackChannelIdSchema);

  it("accepts C and legacy G ids", () => {
    expect(accepts("C012AB3C4")).toBe(true);
    expect(accepts("G012AB3C4")).toBe(true);
    expect(accepts(`C${"A".repeat(20)}`)).toBe(true);
  });

  it("rejects users, DMs, case, length and padding", () => {
    for (const id of [
      "U012AB3C4",
      "D012AB3C4",
      "c012ab3c4",
      "C1",
      `C${"A".repeat(21)}`,
      " C012AB3C4",
      "C012AB3C4\n",
    ]) {
      expect(accepts(id), id).toBe(false);
    }
  });
});
