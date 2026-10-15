import { afterAll, describe, expect, it } from "vitest";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@/generated/prisma/client";
import { withAuditAnonymization, writeAuditEvent } from "@/lib/audit";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const APPEND_ONLY = "AuditEvent is append-only";
const ANONYMIZATION_ONLY = "AuditEvent anonymization may only";

describe.skipIf(!url)("audit event append-only", () => {
  // Own client: @/lib/prisma reads DATABASE_URL, not TEST_DATABASE_URL.
  const prisma = new PrismaClient({
    adapter: new PrismaPg({ connectionString: url }),
  });

  const rand = Math.random().toString(36).slice(2, 10);

  // Rows cannot be deleted, so there is no cleanup: every assertion filters by
  // this run's `rand`.
  afterAll(async () => {
    await prisma.$disconnect();
  });

  async function createEvent(label: string) {
    const targetId = `t13-${rand}-${label}`;
    const event = await writeAuditEvent(prisma, {
      type: "USER_CREATED",
      actorType: "SYSTEM",
      targetType: "USER",
      targetId,
      metadata: { email: "x@northeastern.edu" },
      ip: "203.0.113.7",
      userAgent: "vitest",
    });
    return { event, targetId };
  }

  it("rejects UPDATE through Prisma and raw SQL", async () => {
    const { event } = await createEvent("update");

    await expect(
      prisma.auditEvent.update({
        where: { id: event.id },
        data: { metadata: { changed: true } },
      }),
    ).rejects.toThrow(APPEND_ONLY);
    await expect(
      prisma.$executeRaw`UPDATE "AuditEvent" SET "ip" = NULL WHERE "id" = ${event.id}`,
    ).rejects.toThrow(APPEND_ONLY);
  });

  it("rejects DELETE through Prisma and raw SQL", async () => {
    const { event, targetId } = await createEvent("delete");

    await expect(
      prisma.auditEvent.delete({ where: { id: event.id } }),
    ).rejects.toThrow(APPEND_ONLY);
    await expect(
      prisma.auditEvent.deleteMany({ where: { targetId } }),
    ).rejects.toThrow(APPEND_ONLY);
    await expect(
      prisma.$executeRaw`DELETE FROM "AuditEvent" WHERE "id" = ${event.id}`,
    ).rejects.toThrow(APPEND_ONLY);

    expect(await prisma.auditEvent.count({ where: { targetId } })).toBe(1);
  });

  it("rejects TRUNCATE", async () => {
    // The transaction throws afterwards anyway, so a missing trigger can never
    // wipe the table.
    await expect(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`TRUNCATE "AuditEvent"`;
        throw new Error("rolled back on purpose");
      }),
    ).rejects.toThrow(APPEND_ONLY);
  });

  it("lets the anonymization path null ip/userAgent and rewrite metadata", async () => {
    const { event, targetId } = await createEvent("anonymize");

    await withAuditAnonymization(prisma, (tx) =>
      tx.auditEvent.update({
        where: { id: event.id },
        data: { ip: null, userAgent: null, metadata: { email: null } },
      }),
    );

    const after = await prisma.auditEvent.findFirstOrThrow({
      where: { targetId },
    });
    expect(after.ip).toBeNull();
    expect(after.userAgent).toBeNull();
    expect(after.metadata).toEqual({ email: null });
    expect(after.id).toBe(event.id);
    expect(after.type).toBe(event.type);
    expect(after.actorUserId).toBe(event.actorUserId);
    expect(after.targetId).toBe(event.targetId);
    expect(after.createdAt).toEqual(event.createdAt);
  });

  it("still freezes every other column and DELETE inside the gate", async () => {
    const { event } = await createEvent("frozen");

    await expect(
      withAuditAnonymization(prisma, (tx) =>
        tx.auditEvent.update({
          where: { id: event.id },
          data: { type: "USER_DELETED" },
        }),
      ),
    ).rejects.toThrow(ANONYMIZATION_ONLY);
    await expect(
      withAuditAnonymization(prisma, (tx) =>
        tx.auditEvent.update({
          where: { id: event.id },
          data: { actorUserId: "someone-else" },
        }),
      ),
    ).rejects.toThrow(ANONYMIZATION_ONLY);
    await expect(
      withAuditAnonymization(prisma, (tx) =>
        tx.auditEvent.update({
          where: { id: event.id },
          data: { ip: "198.51.100.9" },
        }),
      ),
    ).rejects.toThrow(ANONYMIZATION_ONLY);
    await expect(
      withAuditAnonymization(prisma, (tx) =>
        tx.auditEvent.delete({ where: { id: event.id } }),
      ),
    ).rejects.toThrow(APPEND_ONLY);
  });

  it("does not leak the gate past the transaction", async () => {
    const { event } = await createEvent("leak");

    await withAuditAnonymization(prisma, (tx) =>
      tx.auditEvent.update({ where: { id: event.id }, data: { ip: null } }),
    );

    await expect(
      prisma.auditEvent.update({
        where: { id: event.id },
        data: { userAgent: null },
      }),
    ).rejects.toThrow(APPEND_ONLY);
  });

  it("creates the three documented indexes", async () => {
    const rows = await prisma.$queryRaw<{ indexname: string }[]>`
      SELECT indexname FROM pg_indexes WHERE tablename = 'AuditEvent'`;
    const names = rows.map((row) => row.indexname);
    expect(names).toEqual(
      expect.arrayContaining([
        "AuditEvent_type_createdAt_idx",
        "AuditEvent_actorUserId_createdAt_idx",
        "AuditEvent_targetType_targetId_createdAt_idx",
      ]),
    );
  });
});
