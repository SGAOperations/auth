import { describe, expect, it } from "vitest";
import { SeedRefusedError, assertSeedAllowed } from "./guard";

describe("assertSeedAllowed", () => {
  it("refuses production and points at positions:sync", () => {
    expect(() => assertSeedAllowed("production")).toThrow(SeedRefusedError);
    expect(() => assertSeedAllowed("production")).toThrow(
      /npm run positions:sync/,
    );
  });

  it.each(["dev", "preview", "local"] as const)("allows %s", (sgauthEnv) => {
    expect(() => assertSeedAllowed(sgauthEnv)).not.toThrow();
  });
});
