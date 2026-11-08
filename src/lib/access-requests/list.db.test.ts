import { beforeEach, describe, expect, it } from "vitest";
import {
  ACCESS_REQUEST_PAGE_SIZE,
  listAccessRequests,
} from "@/lib/access-requests/list";
import { loadHeldPositionKeys } from "@/lib/access-requests/viewer";
import { decodeCursor } from "@/lib/audit-log";
import { prisma } from "@/lib/prisma";
import { createPosition, createUser } from "@/test/factories";

// The table is emptied before each file, and each case starts from empty here.
beforeEach(async () => {
  await prisma.accessRequest.deleteMany();
});

const START = Date.parse("2026-11-01T12:00:00.000Z");

async function seed(count: number, requesterId: string | null = null) {
  const data = Array.from({ length: count }, (_, index) => ({
    requesterId,
    positionKey: "information-manager",
    positionName: "Information Manager",
    product: `Product ${index}`,
    access: "Editor",
    createdAt: new Date(START + index * 60_000),
  }));
  await prisma.accessRequest.createMany({ data });
}

describe("listAccessRequests", () => {
  it("returns a page of 50 newest first and follows the cursor to the end", async () => {
    await seed(ACCESS_REQUEST_PAGE_SIZE + 1);

    const first = await listAccessRequests(prisma);
    expect(first.rows).toHaveLength(ACCESS_REQUEST_PAGE_SIZE);
    expect(first.rows[0].product).toBe(`Product ${ACCESS_REQUEST_PAGE_SIZE}`);
    expect(first.rows.at(-1)?.product).toBe("Product 1");
    expect(first.nextCursor).not.toBeNull();

    const cursor = decodeCursor(first.nextCursor ?? "");
    expect(cursor).not.toBeNull();
    const second = await listAccessRequests(prisma, cursor ?? undefined);
    expect(second.rows.map((row) => row.product)).toEqual(["Product 0"]);
    expect(second.nextCursor).toBeNull();
  });

  it("has no next cursor on a full page that is the last", async () => {
    await seed(ACCESS_REQUEST_PAGE_SIZE);
    const page = await listAccessRequests(prisma);
    expect(page.rows).toHaveLength(ACCESS_REQUEST_PAGE_SIZE);
    expect(page.nextCursor).toBeNull();
  });

  it("orders equal timestamps by id descending without skipping or repeating", async () => {
    const createdAt = new Date(START);
    const ids: string[] = [];
    for (let index = 0; index < ACCESS_REQUEST_PAGE_SIZE + 2; index += 1) {
      const row = await prisma.accessRequest.create({
        data: {
          positionKey: "information-manager",
          positionName: "Information Manager",
          product: `Same ${index}`,
          access: "Editor",
          createdAt,
        },
      });
      ids.push(row.id);
    }
    const expected = [...ids].sort().reverse();

    const first = await listAccessRequests(prisma);
    const cursor = decodeCursor(first.nextCursor ?? "");
    expect(cursor).not.toBeNull();
    const second = await listAccessRequests(prisma, cursor ?? undefined);

    expect([...first.rows, ...second.rows].map((row) => row.id)).toEqual(
      expected,
    );
    expect(second.nextCursor).toBeNull();
  });

  it("returns an empty page for a cursor past the end", async () => {
    await seed(1);
    const page = await listAccessRequests(prisma, {
      createdAt: new Date(START - 1),
      id: "00000000-0000-7000-8000-000000000000",
    });
    expect(page).toEqual({ rows: [], nextCursor: null });
  });

  it("maps a missing or deleted requester to null and keeps a live one", async () => {
    const live = await createUser({ preferredName: "Janie" });
    const deleted = await createUser({ status: "DELETED" });
    await seed(1, live.id);
    await seed(1, deleted.id);
    await seed(1, null);

    const { rows } = await listAccessRequests(prisma);
    const requesters = rows.map((row) => row.requester);
    expect(requesters.filter((requester) => requester === null)).toHaveLength(
      2,
    );
    expect(requesters.find((requester) => requester !== null)).toEqual({
      name: live.name,
      preferredName: "Janie",
      email: live.email,
    });
  });
});

describe("loadHeldPositionKeys", () => {
  it("returns active position keys and leaves out a soft-deleted position", async () => {
    const user = await createUser();
    const active = await createPosition();
    const retired = await createPosition({ deletedAt: new Date() });
    await prisma.userPosition.createMany({
      data: [
        { userId: user.id, positionId: active.id },
        { userId: user.id, positionId: retired.id },
      ],
    });

    expect(await loadHeldPositionKeys(user.id)).toEqual([active.key]);
  });

  it("returns nothing for a user with no positions", async () => {
    const user = await createUser();
    expect(await loadHeldPositionKeys(user.id)).toEqual([]);
  });
});
