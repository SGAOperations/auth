import { describe, expect, it } from "vitest";
import {
  channelMappingInputSchema,
  productSlugForRoleKey,
} from "./channel-mapping-input";

const valid = {
  roleKey: "senate-admin",
  slackTeamId: "T012AB3C4",
  slackChannelId: "C012AB3C4",
};

describe("channelMappingInputSchema", () => {
  it("accepts a valid input", () => {
    expect(channelMappingInputSchema.safeParse(valid).success).toBe(true);
  });

  it("rejects an unknown key", () => {
    expect(
      channelMappingInputSchema.safeParse({ ...valid, extra: 1 }).success,
    ).toBe(false);
  });

  it.each([
    ["roleKey", "Senate-Admin"],
    ["roleKey", " senate-admin"],
    ["slackTeamId", "E012AB3C4"],
    ["slackTeamId", "T012AB3C4 "],
    ["slackChannelId", "U012AB3C4"],
    ["slackChannelId", "c012ab3c4"],
  ])("rejects %s %j", (field, value) => {
    const result = channelMappingInputSchema.safeParse({
      ...valid,
      [field]: value,
    });
    expect(result.success).toBe(false);
    expect(result.error?.issues[0].path[0]).toBe(field);
  });
});

describe("productSlugForRoleKey", () => {
  const slugs = ["senate", "senate-path", "chambers"];

  it("returns null when no slug prefixes the key", () => {
    expect(productSlugForRoleKey("vp-finance", slugs)).toBeNull();
  });

  it("returns null for the bare slug or a trailing hyphen", () => {
    expect(productSlugForRoleKey("senate", slugs)).toBeNull();
    expect(productSlugForRoleKey("senate-", slugs)).toBeNull();
  });

  it("does not match a partial first segment", () => {
    expect(productSlugForRoleKey("senates-admin", slugs)).toBeNull();
  });

  it("resolves the longest slug", () => {
    expect(productSlugForRoleKey("senate-admin", slugs)).toBe("senate");
    expect(productSlugForRoleKey("senate-path-admin", slugs)).toBe(
      "senate-path",
    );
    expect(
      productSlugForRoleKey("senate-path-admin", [...slugs].reverse()),
    ).toBe("senate-path");
  });
});
