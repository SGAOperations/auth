import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  loadPositionHolders,
  positionHoldersBody,
} from "@/lib/position-holders";
import { positionHoldersRoute } from "@/lib/product-api/position-holders-route";
import { authenticateProductKey } from "@/lib/product-api-keys";
import { limitRequest } from "@/lib/rate-limit/server";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/prisma", () => ({ prisma: {} }));
vi.mock("@/lib/log", () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));
vi.mock("@/lib/product-api-keys", () => ({ authenticateProductKey: vi.fn() }));
vi.mock("@/lib/rate-limit/server", () => ({ limitRequest: vi.fn() }));
vi.mock("@/lib/position-holders", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@/lib/position-holders")>()),
  loadPositionHolders: vi.fn(),
}));

const PRODUCT = {
  productId: "0192f0a0-0000-7000-8000-00000000000b",
  slug: "chambers",
  keyId: "0192f0a0-0000-7000-8000-00000000000a",
};

const request = (body: unknown, authorization = "Bearer good") =>
  new Request("https://auth.example/api/products/positions/holders", {
    method: "POST",
    headers: { authorization, "content-type": "application/json" },
    body: JSON.stringify(body),
  });

describe("positionHoldersRoute", () => {
  beforeEach(() => {
    vi.mocked(authenticateProductKey).mockReset();
    vi.mocked(limitRequest).mockReset().mockResolvedValue(null);
    vi.mocked(loadPositionHolders).mockReset();
  });

  it("answers 401 for a missing or bad key and never reads", async () => {
    vi.mocked(authenticateProductKey).mockResolvedValue(null);
    const response = await positionHoldersRoute(
      request({ keys: ["comptroller"] }, "Bearer bad"),
    );
    expect(response.status).toBe(401);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(loadPositionHolders).not.toHaveBeenCalled();
  });

  it("answers 200 with the holders and no-store", async () => {
    vi.mocked(authenticateProductKey).mockResolvedValue(PRODUCT);
    const result = {
      positions: [{ key: "comptroller", name: "Comptroller", holders: [] }],
      unknownKeys: ["nope"],
    };
    vi.mocked(loadPositionHolders).mockResolvedValue(result);
    const response = await positionHoldersRoute(
      request({ keys: ["comptroller", "nope"] }),
    );
    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    await expect(response.json()).resolves.toEqual(result);
    expect(loadPositionHolders).toHaveBeenCalledWith({}, [
      "comptroller",
      "nope",
    ]);
  });

  it("answers 400 naming the bad field and never reads", async () => {
    vi.mocked(authenticateProductKey).mockResolvedValue(PRODUCT);
    const response = await positionHoldersRoute(request({ keys: [] }));
    expect(response.status).toBe(400);
    await expect(response.json()).resolves.toEqual({
      error: "bad_request",
      issues: ["keys"],
    });
    expect(loadPositionHolders).not.toHaveBeenCalled();
  });
});

describe("positionHoldersBody", () => {
  it("accepts one to twenty valid keys", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["comptroller"] }).success,
    ).toBe(true);
    const twenty = Array.from({ length: 20 }, (_, i) => `position-${i}`);
    expect(positionHoldersBody.safeParse({ keys: twenty }).success).toBe(true);
  });

  it("accepts duplicate keys", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["comptroller", "comptroller"] })
        .success,
    ).toBe(true);
  });

  it("rejects no keys and more than twenty", () => {
    expect(positionHoldersBody.safeParse({ keys: [] }).success).toBe(false);
    const twentyOne = Array.from({ length: 21 }, (_, i) => `position-${i}`);
    expect(positionHoldersBody.safeParse({ keys: twentyOne }).success).toBe(
      false,
    );
  });

  it("rejects keys with upper case or spaces", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["VP Finance"] }).success,
    ).toBe(false);
    expect(
      positionHoldersBody.safeParse({ keys: ["Comptroller"] }).success,
    ).toBe(false);
  });

  it("rejects unknown fields and a missing keys field", () => {
    expect(
      positionHoldersBody.safeParse({ keys: ["comptroller"], extra: 1 })
        .success,
    ).toBe(false);
    expect(positionHoldersBody.safeParse({}).success).toBe(false);
  });
});
