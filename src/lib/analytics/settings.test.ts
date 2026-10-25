import { describe, expect, it } from "vitest";
import { resolvePostHogSettings } from "@/lib/analytics/settings";

const configured = {
  POSTHOG_KEY: "phc_test",
  POSTHOG_HOST: "https://us.i.posthog.com",
  NODE_ENV: "production",
};

describe("resolvePostHogSettings", () => {
  it("returns the key and host when configured", () => {
    expect(resolvePostHogSettings(configured)).toEqual({
      key: "phc_test",
      host: "https://us.i.posthog.com",
    });
  });

  it("accepts POSTHOG_DISABLED=false", () => {
    expect(
      resolvePostHogSettings({ ...configured, POSTHOG_DISABLED: "false" }),
    ).not.toBeNull();
  });

  it("is off when POSTHOG_DISABLED=true", () => {
    expect(
      resolvePostHogSettings({ ...configured, POSTHOG_DISABLED: "true" }),
    ).toBeNull();
  });

  it("is off under NODE_ENV=test", () => {
    expect(
      resolvePostHogSettings({ ...configured, NODE_ENV: "test" }),
    ).toBeNull();
  });

  it("is off without a key", () => {
    expect(
      resolvePostHogSettings({ ...configured, POSTHOG_KEY: undefined }),
    ).toBeNull();
  });

  it("is off without a host", () => {
    expect(
      resolvePostHogSettings({ ...configured, POSTHOG_HOST: undefined }),
    ).toBeNull();
  });
});
