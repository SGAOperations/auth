import { describe, expect, it } from "vitest";
import { ACCESS_REQUEST_LIMITS } from "@/lib/access-requests/limits";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/test/factories";

const UUID_V7 =
  /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const make = (data: Record<string, unknown> = {}) =>
  prisma.accessRequest.create({
    data: {
      requesterId: null,
      positionKey: "president",
      positionName: "President",
      product: "Aplio",
      access: "Editor on the events calendar",
      ...data,
    },
  });

describe("AccessRequest schema", () => {
  it("stores a valid row with a UUID v7 id and createdAt set", async () => {
    const user = await createUser();
    const row = await make({ requesterId: user.id });
    expect(row.id).toMatch(UUID_V7);
    expect(row.createdAt).toBeInstanceOf(Date);
    expect(row.requesterId).toBe(user.id);
  });

  it("accepts a row with no requester", async () => {
    const row = await make({ requesterId: null });
    expect(row.requesterId).toBeNull();
  });

  it("accepts product and access at their limits", async () => {
    await expect(
      make({
        product: "p".repeat(ACCESS_REQUEST_LIMITS.product),
        access: "a".repeat(ACCESS_REQUEST_LIMITS.access),
      }),
    ).resolves.toBeDefined();
  });

  it("rejects a product over its limit", async () => {
    await expect(
      make({ product: "p".repeat(ACCESS_REQUEST_LIMITS.product + 1) }),
    ).rejects.toThrow(/AccessRequest_product_length_check/);
  });

  it("rejects access over its limit", async () => {
    await expect(
      make({ access: "a".repeat(ACCESS_REQUEST_LIMITS.access + 1) }),
    ).rejects.toThrow(/AccessRequest_access_length_check/);
  });

  it("rejects an empty or whitespace-only product or access", async () => {
    for (const value of ["", "   "]) {
      await expect(make({ product: value })).rejects.toThrow(
        /AccessRequest_product_length_check/,
      );
      await expect(make({ access: value })).rejects.toThrow(
        /AccessRequest_access_length_check/,
      );
    }
  });

  it("rejects an empty or whitespace-only position snapshot", async () => {
    for (const value of ["", "   "]) {
      await expect(make({ positionKey: value })).rejects.toThrow(
        /AccessRequest_position_snapshot_check/,
      );
      await expect(make({ positionName: value })).rejects.toThrow(
        /AccessRequest_position_snapshot_check/,
      );
    }
  });

  it("clears the requester and keeps the row when the user row is deleted", async () => {
    const user = await createUser();
    const row = await make({ requesterId: user.id });
    await prisma.user.delete({ where: { id: user.id } });
    expect(
      await prisma.accessRequest.findUniqueOrThrow({ where: { id: row.id } }),
    ).toMatchObject({ requesterId: null, product: row.product });
  });
});
