import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { AplioRow } from "@/lib/import/aplio";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/test/factories";
import { applyAplioImport, readReconcileState } from "./aplio";

const suffix = randomBytes(4).toString("hex");
let counter = 0;

function row(overrides: Partial<AplioRow> = {}): AplioRow {
  counter += 1;
  return {
    aplioId: `aplio-${counter}-${suffix}`,
    email: `aplio-${counter}-${suffix}@northeastern.edu`,
    name: `Aplio ${counter}`,
    isAdmin: false,
    deletedAt: null,
    sgauthUserId: null,
    ...overrides,
  };
}

const apply = (rows: AplioRow[], sha = randomBytes(32).toString("hex")) =>
  applyAplioImport(prisma, { rows, sourceSha256: sha }).then((plan) => ({
    plan,
    sha,
  }));

const auditEvents = (sha: string) =>
  prisma.auditEvent.findMany({
    where: {
      type: "BULK_IMPORT",
      metadata: { path: ["sourceSha256"], equals: sha },
    },
  });

describe("applyAplioImport", () => {
  it("creates password-less verified users and writes one BULK_IMPORT row", async () => {
    const admin = row({ isAdmin: true });
    const legacy = row({ email: `legacy-${suffix}@example.org` });
    const soft = row({ deletedAt: "2025-01-01T00:00:00Z" });
    const { plan, sha } = await apply([row(), admin, legacy, soft]);

    expect(plan.counts).toMatchObject({
      create: 3,
      skip: 1,
      legacyEmails: 1,
      aplioAdmins: 1,
    });

    const adminUser = await prisma.user.findUniqueOrThrow({
      where: { email: admin.email },
    });
    expect(adminUser).toMatchObject({
      emailVerified: true,
      status: "ACTIVE",
      isAdmin: false,
    });
    const legacyUser = await prisma.user.findUniqueOrThrow({
      where: { email: legacy.email },
    });
    expect(legacyUser.legacyEmail).toBe(true);
    expect(await prisma.user.count({ where: { email: soft.email } })).toBe(0);

    const ids = plan.rows.map((entry) => entry.userId);
    expect(ids.slice(0, 3).every((id) => id !== null)).toBe(true);
    expect(ids[3]).toBeNull();

    expect(
      await prisma.account.count({
        where: { userId: { in: [adminUser.id, legacyUser.id] } },
      }),
    ).toBe(0);
    expect(
      await prisma.verification.count({
        where: { identifier: { in: [admin.email, legacy.email] } },
      }),
    ).toBe(0);

    const events = await auditEvents(sha);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "SYSTEM",
      metadata: {
        source: "aplio",
        created: 3,
        merged: 0,
        skipped: 1,
        legacyEmails: 1,
        aplioAdmins: 1,
      },
    });
    expect(JSON.stringify(events[0].metadata)).not.toContain(suffix);
  });

  it("converges: a second apply creates nothing and maps the same ids", async () => {
    const rows = [row(), row()];
    const first = await apply(rows);
    const second = await apply(rows);
    expect(second.plan.counts).toMatchObject({ create: 0, merge: 2 });
    expect(second.plan.rows.map((entry) => entry.userId)).toEqual(
      first.plan.rows.map((entry) => entry.userId),
    );
  });

  it("merges into a Chambers user without touching its password", async () => {
    const existing = await createUser({
      name: "Chambers Name",
      password: "chambers-password-1",
    });
    const before = await prisma.account.findFirstOrThrow({
      where: { userId: existing.id },
    });
    const { plan } = await apply([
      row({ email: existing.email.toUpperCase(), name: "Aplio Name" }),
    ]);
    expect(plan.rows[0]).toMatchObject({
      outcome: "merge",
      userId: existing.id,
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(after.name).toBe("Chambers Name");
    const account = await prisma.account.findFirstOrThrow({
      where: { userId: existing.id },
    });
    expect(account.password).toBe(before.password);
  });

  it("maps an in-file duplicate to the one created user", async () => {
    const first = row();
    const { plan } = await apply([
      first,
      row({ email: first.email.toUpperCase() }),
    ]);
    expect(plan.counts).toMatchObject({ create: 1, duplicateInSource: 1 });
    expect(plan.rows[1].userId).toBe(plan.rows[0].userId);
    expect(plan.rows[1].userId).not.toBeNull();
  });

  it("does not map an unverified existing user", async () => {
    const existing = await createUser({ emailVerified: false });
    const { plan } = await apply([row({ email: existing.email })]);
    expect(plan.rows[0]).toMatchObject({ outcome: "skip", userId: null });
  });
});

describe("readReconcileState", () => {
  it("returns users created through the dual write, and no others", async () => {
    const viaDualWrite = await createUser();
    await prisma.auditEvent.create({
      data: {
        type: "USER_CREATED",
        actorType: "SYSTEM",
        targetType: "USER",
        targetId: viaDualWrite.id,
        metadata: { source: "aplio_dual_write" },
      },
    });
    const other = await createUser();
    await prisma.auditEvent.create({
      data: {
        type: "USER_CREATED",
        actorType: "SYSTEM",
        targetType: "USER",
        targetId: other.id,
        metadata: { source: "admin" },
      },
    });
    const { state, dualWriteUsers } = await readReconcileState(prisma, [
      row({ email: viaDualWrite.email }),
    ]);
    expect(state.users.get(viaDualWrite.email.toLowerCase())?.id).toBe(
      viaDualWrite.id,
    );
    const ids = dualWriteUsers.map((user) => user.userId);
    expect(ids).toContain(viaDualWrite.id);
    expect(ids).not.toContain(other.id);
  });
});
