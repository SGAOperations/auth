import { beforeEach, describe, expect, it } from "vitest";
import {
  getAcceptView,
  getInFlightTransfer,
  getRecentCompletion,
  listRecipientCandidates,
} from "@/lib/admin/transfer-queries";
import { prisma } from "@/lib/prisma";
import { createAdmin, createUser } from "@/test/factories";

const DAY_MS = 24 * 60 * 60 * 1000;

describe("transfer queries", () => {
  beforeEach(async () => {
    await prisma.primaryAdminTransfer.deleteMany();
  });

  describe("listRecipientCandidates", () => {
    it("lists admins by name, keeps the deactivated, and leaves out the deleted and non-admins", async () => {
      const tag = `qc-${Math.random().toString(36).slice(2, 8)}`;
      const b = await createAdmin({ name: `${tag} B` });
      const a = await createAdmin({ name: `${tag} A` });
      const off = await createAdmin({
        name: `${tag} C`,
        status: "DEACTIVATED",
      });
      const gone = await createAdmin({ name: `${tag} D`, status: "DELETED" });
      const plain = await createUser({ name: `${tag} E` });

      const ids = (await listRecipientCandidates())
        .filter((candidate) => candidate.name.startsWith(tag))
        .map((candidate) => candidate.id);

      expect(ids).toEqual([a.id, b.id, off.id]);
      expect(ids).not.toContain(gone.id);
      expect(ids).not.toContain(plain.id);
    });
  });

  describe("getInFlightTransfer", () => {
    it("returns the pending or cooling transfer with both names, and nothing secret", async () => {
      expect(await getInFlightTransfer()).toBeNull();

      const from = await createAdmin();
      const to = await createAdmin({ preferredName: "Riley" });
      await prisma.primaryAdminTransfer.create({
        data: {
          fromUserId: from.id,
          toUserId: to.id,
          status: "COOLING",
          acceptedAt: new Date(),
          executesAt: new Date(Date.now() + DAY_MS),
          cancelTokenHash: "secret-hash",
        },
      });

      const found = await getInFlightTransfer();
      expect(found).toMatchObject({
        status: "COOLING",
        fromUserId: from.id,
        toUserId: to.id,
        toUser: { name: to.name, preferredName: "Riley" },
      });
      expect(JSON.stringify(found)).not.toContain("secret-hash");
      expect(found).not.toHaveProperty("cancelTokenHash");
    });

    it("ignores finished transfers", async () => {
      const from = await createAdmin();
      const to = await createAdmin();
      await prisma.primaryAdminTransfer.create({
        data: { fromUserId: from.id, toUserId: to.id, status: "CANCELLED" },
      });
      expect(await getInFlightTransfer()).toBeNull();
    });
  });

  describe("getAcceptView", () => {
    it("shows the recipient their transfer and nobody else", async () => {
      const from = await createAdmin();
      const to = await createAdmin();
      const third = await createAdmin();
      const transfer = await prisma.primaryAdminTransfer.create({
        data: { fromUserId: from.id, toUserId: to.id },
      });

      const view = await getAcceptView(to.id);
      expect(view).toMatchObject({
        id: transfer.id,
        status: "PENDING_ACCEPTANCE",
        fromUser: { name: from.name },
      });
      expect(view).not.toHaveProperty("cancelTokenHash");

      // The sender and a third admin get what a missing transfer gets.
      expect(await getAcceptView(third.id)).toBeNull();
      expect(await getAcceptView(from.id)).toBeNull();
    });

    it("returns the newest transfer addressed to the viewer", async () => {
      const from = await createAdmin();
      const to = await createAdmin();
      await prisma.primaryAdminTransfer.create({
        data: {
          fromUserId: from.id,
          toUserId: to.id,
          status: "CANCELLED",
          createdAt: new Date(Date.now() - 10 * DAY_MS),
        },
      });
      const latest = await prisma.primaryAdminTransfer.create({
        data: { fromUserId: from.id, toUserId: to.id },
      });
      expect((await getAcceptView(to.id))?.id).toBe(latest.id);
    });
  });

  describe("getRecentCompletion", () => {
    it("returns the latest completion within seven days only", async () => {
      const now = new Date();
      const from = await createAdmin();
      const to = await createAdmin();
      const complete = (completedAt: Date) =>
        prisma.primaryAdminTransfer.create({
          data: {
            fromUserId: from.id,
            toUserId: to.id,
            status: "COMPLETED",
            completedAt,
          },
        });

      expect(await getRecentCompletion(now)).toBeNull();

      await complete(new Date(now.getTime() - 8 * DAY_MS));
      expect(await getRecentCompletion(now)).toBeNull();

      const recent = await complete(new Date(now.getTime() - 2 * DAY_MS));
      const found = await getRecentCompletion(now);
      expect(found?.id).toBe(recent.id);
      expect(found?.toUser.name).toBe(to.name);
      expect(found).not.toHaveProperty("cancelTokenHash");

      // Seven days on, the banner is gone.
      expect(
        await getRecentCompletion(new Date(now.getTime() + 6 * DAY_MS)),
      ).toBeNull();
    });
  });
});
