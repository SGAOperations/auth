import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { provisionAplioUser } from "@/lib/import/aplio-dual-write";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/test/factories";

const suffix = randomBytes(4).toString("hex");
let counter = 0;
const nextEmail = () => {
  counter += 1;
  return `aplio-${counter}-${suffix}@northeastern.edu`;
};

const createdEvents = (userId: string) =>
  prisma.auditEvent.findMany({
    where: { type: "USER_CREATED", targetId: userId },
  });

describe("provisionAplioUser", () => {
  it("creates a verified, password-less, non-admin user and audits it", async () => {
    const email = nextEmail();
    const result = await provisionAplioUser(prisma, { email, name: "Ada" });
    expect(result.status).toBe("created");
    if (result.status !== "created") return;

    const user = await prisma.user.findUniqueOrThrow({
      where: { email },
    });
    expect(user).toMatchObject({
      id: result.userId,
      name: "Ada",
      emailVerified: true,
      status: "ACTIVE",
      isAdmin: false,
      legacyEmail: false,
    });
    expect(await prisma.account.count({ where: { userId: user.id } })).toBe(0);
    expect(
      await prisma.verification.count({ where: { identifier: email } }),
    ).toBe(0);

    const events = await createdEvents(user.id);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "SYSTEM",
      targetType: "USER",
      metadata: { source: "aplio_dual_write" },
    });
  });

  it("flags a non-northeastern address as legacy", async () => {
    const email = `legacy-${suffix}@example.org`;
    await provisionAplioUser(prisma, { email, name: null });
    const user = await prisma.user.findUniqueOrThrow({ where: { email } });
    expect(user).toMatchObject({ legacyEmail: true, name: `legacy-${suffix}` });
  });

  it("is idempotent: a repeat returns the same id and writes no second row", async () => {
    const email = nextEmail();
    const first = await provisionAplioUser(prisma, { email, name: "Ada" });
    const second = await provisionAplioUser(prisma, { email, name: "Ada" });
    expect(second).toEqual({
      status: "existing",
      userId: first.status === "created" ? first.userId : "",
    });
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    if (first.status === "created") {
      expect(await createdEvents(first.userId)).toHaveLength(1);
    }
  });

  it("returns an existing verified user untouched, keeping its password", async () => {
    const existing = await createUser({
      name: "Kept",
      password: "hunter2hunter2",
    });
    const result = await provisionAplioUser(prisma, {
      email: existing.email,
      name: "Renamed",
    });
    expect(result).toEqual({ status: "existing", userId: existing.id });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(after.name).toBe("Kept");
    expect(
      await prisma.account.count({
        where: { userId: existing.id, password: { not: null } },
      }),
    ).toBe(1);
    expect(await createdEvents(existing.id)).toHaveLength(0);
  });

  it("refuses an unverified account", async () => {
    const existing = await createUser({ emailVerified: false });
    expect(
      await provisionAplioUser(prisma, { email: existing.email, name: "X" }),
    ).toEqual({ status: "unverified" });
  });

  it("refuses a tombstoned account", async () => {
    const existing = await createUser({ status: "DELETED" });
    expect(
      await provisionAplioUser(prisma, { email: existing.email, name: "X" }),
    ).toEqual({ status: "tombstoned" });
  });

  it("makes one user from two concurrent calls for the same address", async () => {
    const email = nextEmail();
    const results = await Promise.all([
      provisionAplioUser(prisma, { email, name: "Ada" }),
      provisionAplioUser(prisma, { email, name: "Ada" }),
    ]);
    expect(await prisma.user.count({ where: { email } })).toBe(1);
    const ids = results.map((result) =>
      "userId" in result ? result.userId : null,
    );
    expect(ids[0]).not.toBeNull();
    expect(ids[0]).toBe(ids[1]);
    expect(results.map((result) => result.status).sort()).toEqual([
      "created",
      "existing",
    ]);
    expect(await createdEvents(ids[0]!)).toHaveLength(1);
  });
});
