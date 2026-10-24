import { describe, expect, it, vi } from "vitest";
import {
  PRODUCT_CACHE_TTL_MS,
  PRODUCT_FAILURE_TTL_MS,
  createProductRegistry,
  isLocalDevOrigin,
  normalizeOrigin,
  type RegistryProductRow,
} from "@/lib/product-registry";
import type { SgauthEnv } from "@/lib/env-schema";

const OWN = "https://auth-dev.northeasternsga.com";
const VAULTZ = "https://vaultz-dev.northeasternsga.com";

function row(baseUrl: string, slug = "p"): RegistryProductRow {
  return {
    slug,
    name: "Product",
    description: "",
    baseUrl,
    iconUrl: null,
    sortOrder: 0,
    visibleToPositionKeys: [],
    loginRedirectPath: null,
  };
}

function setup(
  options: {
    rows?: RegistryProductRow[];
    sgauthEnv?: SgauthEnv;
    ownOrigin?: string;
  } = {},
) {
  const loader = vi.fn<() => Promise<readonly RegistryProductRow[]>>(
    async () => options.rows ?? [row(VAULTZ)],
  );
  const log = { warn: vi.fn(), error: vi.fn() };
  const clock = { t: 1_000_000 };
  const registry = createProductRegistry({
    loadActiveProducts: loader,
    ownOrigin: options.ownOrigin ?? OWN,
    sgauthEnv: options.sgauthEnv ?? "dev",
    log,
    now: () => clock.t,
  });
  return { registry, loader, log, clock };
}

function requestWith(headers: Record<string, string>): Request {
  return new Request("http://auth.sga.localhost:3000/api/auth/sign-out", {
    method: "POST",
    headers,
  });
}

describe("normalizeOrigin", () => {
  it.each([
    [
      "https://vaultz.northeasternsga.com/",
      "https://vaultz.northeasternsga.com",
    ],
    [
      "https://Vaultz.NortheasternSGA.com",
      "https://vaultz.northeasternsga.com",
    ],
    [
      "https://vaultz.northeasternsga.com:443",
      "https://vaultz.northeasternsga.com",
    ],
    [
      "https://vaultz.northeasternsga.com:8443",
      "https://vaultz.northeasternsga.com:8443",
    ],
    [
      "https://vaultz.northeasternsga.com/a?b#c",
      "https://vaultz.northeasternsga.com",
    ],
    ["http://vaultz.sga.localhost:3001/", "http://vaultz.sga.localhost:3001"],
    ["https://u:p@vaultz.northeasternsga.com", null],
    [" https://vaultz.northeasternsga.com", null],
    ["javascript:alert(1)", null],
    ["not a url", null],
  ])("%j -> %j", (input, expected) => {
    expect(normalizeOrigin(input)).toBe(expected);
  });
});

describe("isLocalDevOrigin", () => {
  it.each(["http://vaultz.sga.localhost:3001", "http://a.b.sga.localhost"])(
    "accepts %s",
    (origin) => {
      expect(isLocalDevOrigin(origin)).toBe(true);
    },
  );

  it.each([
    "http://localhost:3000",
    "http://sga.localhost:3000",
    "https://vaultz.sga.localhost:3001",
    "http://x.sga.localhost.evil.com",
    "http://vaultz.sga.localhost:3001/",
    "http://VAULTZ.sga.localhost:3001",
  ])("rejects %s", (origin) => {
    expect(isLocalDevOrigin(origin)).toBe(false);
  });
});

describe("getTrustedOrigins", () => {
  it("returns the own origin and every active product origin", async () => {
    const { registry } = setup();
    expect(await registry.getTrustedOrigins()).toEqual([OWN, VAULTZ]);
  });

  it("does not trust a ported origin, and accepts a cased redirect", async () => {
    const { registry } = setup();
    expect(await registry.getTrustedOrigins()).not.toContain(
      "https://vaultz-dev.northeasternsga.com:8443",
    );
    expect(
      await registry.isAllowedRedirect(
        "https://vaultz-dev.northeasternsga.com:8443/",
      ),
    ).toBe(false);
    expect(
      await registry.isAllowedRedirect(
        "https://VAULTZ-dev.northeasternsga.com/",
      ),
    ).toBe(true);
    expect(
      await registry.isAllowedRedirect(
        "https://vaultz-dev.northeasternsga.com/x",
      ),
    ).toBe(true);
  });

  it("lists the own origin once when a row duplicates it", async () => {
    const { registry } = setup({ rows: [row(OWN)] });
    expect(await registry.getTrustedOrigins()).toEqual([OWN]);
  });

  it.each([
    "https://x.vercel.app",
    "https://*.northeasternsga.com",
    "http://x.northeasternsga.com",
    "https://x.northeasternsga.com/",
    "https://northeasternsga.com",
  ])("skips the row %s and warns with its slug", async (baseUrl) => {
    const { registry, log } = setup({ rows: [row(baseUrl, "bad")] });
    expect(await registry.getTrustedOrigins()).toEqual([OWN]);
    expect(await registry.getActiveProducts()).toEqual([]);
    expect(log.warn).toHaveBeenCalledWith(expect.any(String), { slug: "bad" });
  });
});

describe("cache", () => {
  it("loads once for calls within the TTL", async () => {
    const { registry, loader } = setup();
    for (let i = 0; i < 10; i++) await registry.getTrustedOrigins();
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("shares one load between concurrent callers", async () => {
    const { registry, loader } = setup();
    await Promise.all(
      Array.from({ length: 5 }, () => registry.getTrustedOrigins()),
    );
    expect(loader).toHaveBeenCalledTimes(1);
  });

  it("reloads once the TTL has passed", async () => {
    const { registry, loader, clock } = setup();
    await registry.getTrustedOrigins();
    clock.t += PRODUCT_CACHE_TTL_MS;
    await registry.getTrustedOrigins();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("reloads after invalidate()", async () => {
    const { registry, loader } = setup();
    await registry.getTrustedOrigins();
    registry.invalidate();
    await registry.getTrustedOrigins();
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("does not store a load that an invalidate() overtook", async () => {
    const { registry, loader } = setup();
    let release: (rows: RegistryProductRow[]) => void = () => {};
    loader.mockImplementationOnce(
      () => new Promise<RegistryProductRow[]>((resolve) => (release = resolve)),
    );
    const stale = registry.getTrustedOrigins();
    registry.invalidate();
    release([row("https://old.northeasternsga.com")]);
    expect(await stale).toContain("https://old.northeasternsga.com");

    expect(await registry.getTrustedOrigins()).toEqual([OWN, VAULTZ]);
    expect(loader).toHaveBeenCalledTimes(2);
  });
});

describe("registry failure", () => {
  it("trusts only the own origin and logs the error name, not the message", async () => {
    const { registry, loader, log } = setup();
    loader.mockRejectedValueOnce(new TypeError("postgres://user:pw@host"));
    expect(await registry.getTrustedOrigins()).toEqual([OWN]);
    expect(await registry.getActiveProducts()).toEqual([]);
    expect(log.error).toHaveBeenCalledTimes(1);
    expect(log.error).toHaveBeenCalledWith(expect.stringContaining("[ALERT]"), {
      errorName: "TypeError",
    });
  });

  it("retries only after the failure TTL", async () => {
    const { registry, loader, clock } = setup();
    loader.mockRejectedValueOnce(new Error("down"));
    await registry.getTrustedOrigins();
    clock.t += PRODUCT_FAILURE_TTL_MS - 1;
    await registry.getTrustedOrigins();
    expect(loader).toHaveBeenCalledTimes(1);
    clock.t += 1;
    expect(await registry.getTrustedOrigins()).toEqual([OWN, VAULTZ]);
    expect(loader).toHaveBeenCalledTimes(2);
  });

  it("never reuses the last good list after a failed reload", async () => {
    const { registry, loader, clock } = setup();
    expect(await registry.getTrustedOrigins()).toEqual([OWN, VAULTZ]);
    loader.mockRejectedValueOnce(new Error("down"));
    clock.t += PRODUCT_CACHE_TTL_MS;
    expect(await registry.getTrustedOrigins()).toEqual([OWN]);
  });

  it("denies a product redirect but keeps SGAuth's own", async () => {
    const { registry, loader } = setup();
    loader.mockRejectedValueOnce(new Error("down"));
    expect(await registry.isAllowedRedirect(`${VAULTZ}/x`)).toBe(false);
    expect(await registry.isAllowedRedirect(`${OWN}/account`)).toBe(true);
  });
});

describe("local origin echo", () => {
  const local = () =>
    setup({ sgauthEnv: "local", ownOrigin: "http://auth.sga.localhost:3000" });

  it("echoes an *.sga.localhost Origin", async () => {
    const { registry } = local();
    const origins = await registry.getTrustedOrigins(
      requestWith({ origin: "http://vaultz.sga.localhost:3001" }),
    );
    expect(origins).toContain("http://vaultz.sga.localhost:3001");
  });

  it.each([
    "http://localhost:3000",
    "http://evil.com",
    "http://x.sga.localhost.evil.com",
    "https://vaultz.sga.localhost:3001",
  ])("does not echo the Origin %s", async (origin) => {
    const { registry } = local();
    const origins = await registry.getTrustedOrigins(requestWith({ origin }));
    expect(origins).not.toContain(origin);
  });

  it("does not echo outside local", async () => {
    const { registry } = setup({ sgauthEnv: "dev" });
    const origins = await registry.getTrustedOrigins(
      requestWith({ origin: "http://vaultz.sga.localhost:3001" }),
    );
    expect(origins).not.toContain("http://vaultz.sga.localhost:3001");
  });

  it("takes the origin of a Referer", async () => {
    const { registry } = local();
    const origins = await registry.getTrustedOrigins(
      requestWith({ referer: "http://a.sga.localhost:4000/path" }),
    );
    expect(origins).toContain("http://a.sga.localhost:4000");
  });

  it("allows a local redirect and rejects bare localhost", async () => {
    const { registry } = local();
    expect(
      await registry.isAllowedRedirect("http://vaultz.sga.localhost:3001/x"),
    ).toBe(true);
    expect(await registry.isAllowedRedirect("http://localhost:3001/x")).toBe(
      false,
    );
  });
});

describe("isAllowedRedirect", () => {
  it.each([
    "/account",
    "/a/b?x=1#f",
    "https://vaultz-dev.northeasternsga.com/purchases/42",
    "https://auth-dev.northeasternsga.com/account",
    "https://VAULTZ-dev.northeasternsga.com/x",
  ])("allows %s", async (url) => {
    const { registry } = setup();
    expect(await registry.isAllowedRedirect(url)).toBe(true);
  });

  it.each([
    "//evil.com",
    "/\\evil.com",
    "/%2F%2Fevil.com",
    "/%5cevil.com",
    "https://evil.com",
    "https://unregistered.northeasternsga.com/",
    "http://vaultz-dev.northeasternsga.com/",
    "https://vaultz-dev.northeasternsga.com@evil.com/",
    "https://evil.com\\@vaultz-dev.northeasternsga.com",
    "https://vаultz-dev.northeasternsga.com/",
    "https://vaultz-dev.northeasternsga.com.evil.com/",
    "javascript:alert(1)",
    "data:text/html,x",
    "",
    " /account",
    `/${"a".repeat(2048)}`,
    "https://x.vercel.app/",
  ])("rejects %j", async (url) => {
    const { registry } = setup();
    expect(await registry.isAllowedRedirect(url)).toBe(false);
  });
});
