import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { SenatePortalRow } from "@/lib/import/senateportal";
import { prisma } from "@/lib/prisma";
import { createUser } from "@/test/factories";
import { applySenatePortalImport } from "./senateportal";

const suffix = randomBytes(4).toString("hex");
let counter = 0;

function row(overrides: Partial<SenatePortalRow> = {}): SenatePortalRow {
  counter += 1;
  return {
    senatePortalId: `portal-${counter}-${suffix}`,
    email: `portal-${counter}-${suffix}@northeastern.edu`,
    name: `Portal ${counter}`,
    deletedAt: null,
    ...overrides,
  };
}

const apply = (
  rows: SenatePortalRow[],
  sha = randomBytes(32).toString("hex"),
) =>
  applySenatePortalImport(prisma, { rows, sourceSha256: sha }).then((plan) => ({
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

describe("applySenatePortalImport", () => {
  it("creates password-less verified users with no positions, and writes one BULK_IMPORT row", async () => {
    const plain = row();
    const legacy = row({ email: `legacy-${suffix}@example.org` });
    const soft = row({ deletedAt: "2025-01-01T00:00:00Z" });
    const { plan, sha } = await apply([plain, legacy, soft]);

    expect(plan.counts).toMatchObject({
      create: 2,
      skip: 1,
      legacyEmails: 1,
    });

    const users = await prisma.user.findMany({
      where: { email: { in: [plain.email, legacy.email] } },
    });
    expect(users).toHaveLength(2);
    for (const user of users) {
      expect(user).toMatchObject({
        emailVerified: true,
        status: "ACTIVE",
        isAdmin: false,
        legacyEmail: user.email === legacy.email,
      });
    }
    expect(await prisma.user.count({ where: { email: soft.email } })).toBe(0);

    const ids = users.map((user) => user.id);
    expect(
      plan.rows
        .slice(0, 2)
        .map((entry) => entry.userId)
        .sort(),
    ).toEqual([...ids].sort());
    expect(plan.rows[2].userId).toBeNull();

    expect(await prisma.account.count({ where: { userId: { in: ids } } })).toBe(
      0,
    );
    expect(
      await prisma.userPosition.count({ where: { userId: { in: ids } } }),
    ).toBe(0);
    expect(
      await prisma.verification.count({
        where: { identifier: { in: [plain.email, legacy.email] } },
      }),
    ).toBe(0);

    const events = await auditEvents(sha);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      actorType: "SYSTEM",
      metadata: {
        source: "senateportal",
        created: 2,
        merged: 0,
        duplicateInSource: 0,
        skipped: 1,
        legacyEmails: 1,
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

  it("merges into an existing user without touching its name, password or positions", async () => {
    const existing = await createUser({
      name: "Chambers Name",
      password: "chambers-password-1",
    });
    const before = await prisma.account.findFirstOrThrow({
      where: { userId: existing.id },
    });
    const { plan } = await apply([
      row({ email: existing.email.toLowerCase(), name: "Portal Name" }),
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
    expect(
      await prisma.userPosition.count({ where: { userId: existing.id } }),
    ).toBe(0);
  });

  it("never reactivates a deactivated user", async () => {
    const existing = await createUser({ status: "DEACTIVATED" });
    const { plan } = await apply([row({ email: existing.email })]);
    expect(plan.rows[0]).toMatchObject({
      outcome: "merge",
      notes: ["deactivated in SGAuth"],
    });
    const after = await prisma.user.findUniqueOrThrow({
      where: { id: existing.id },
    });
    expect(after.status).toBe("DEACTIVATED");
  });

  it("maps an in-file duplicate to the one created user", async () => {
    const first = row();
    const { plan } = await apply([first, row({ email: first.email })]);
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
