import { randomBytes, randomUUID } from "node:crypto";
import bcrypt from "bcryptjs";
import { describe, expect, it } from "vitest";
import type {
  ChambersExport,
  ChambersExportUser,
} from "@/lib/import/chambers-export";
import { prisma } from "@/lib/prisma";
import { createPosition, createUser } from "@/test/factories";
import {
  ImportInputError,
  applyImport,
  planImport,
  readImportState,
  toImportRow,
  type ImportMapping,
  type Replacements,
} from "./chambers";

const NOW = new Date();
const TIMEOUT = 60_000;
const suffix = randomBytes(4).toString("hex");
let counter = 0;

// Cost 4 keeps the fixtures fast; the validator accepts cost 04 to 31.
const hash = () => bcrypt.hashSync(randomBytes(6).toString("hex"), 4);

function exportUser(
  overrides: Partial<ChambersExportUser> = {},
): ChambersExportUser {
  counter += 1;
  return {
    id: randomUUID(),
    email: `import-${counter}-${suffix}@northeastern.edu`,
    full_name: `Imported ${counter}`,
    password_hash: hash(),
    email_verified: true,
    email_confirmed_at: null,
    last_sign_in_at: null,
    banned_until: null,
    is_active: true,
    admin_role: null,
    iems_role: null,
    created_at: "2025-09-01T12:00:00+00:00",
    board_memberships: [],
    ...overrides,
  };
}

function membership(bodyId: string, role: "Leadership" | "Member") {
  return { body_id: bodyId, body_name: `Body ${bodyId.slice(0, 4)}`, role };
}

function mappingOf(roles: Record<string, string[]>): ImportMapping {
  return {
    approvedBy: null,
    approvedAt: null,
    roles: new Map(Object.entries(roles)),
    sha256: "b".repeat(64),
  };
}

function replacementsOf(entries: Record<string, string> = {}): Replacements {
  return new Map(
    Object.entries(entries).map(([old, email], index) => [
      old,
      { email, line: index + 1 },
    ]),
  );
}

function sourceOf(users: ChambersExportUser[]) {
  const data: ChambersExport = {
    format: "sgauth-chambers-export",
    version: 1,
    source: "chambers-neon",
    exported_at: NOW.toISOString(),
    users,
  };
  return { data, sha: randomBytes(32).toString("hex") };
}

async function apply(
  source: ReturnType<typeof sourceOf>,
  roles: Record<string, string[]>,
  replacements: Replacements = new Map(),
) {
  const mapping = mappingOf(roles);
  const rows = source.data.users.map((user) =>
    toImportRow(user, replacements, NOW),
  );
  return applyImport(prisma, {
    rows,
    exportSource: source.data.source,
    mapping,
    replacements,
    checksums: { source: source.sha, replacements: null },
    now: NOW,
  });
}

const auditEvents = (sha: string) =>
  prisma.auditEvent.findMany({
    where: {
      type: "BULK_IMPORT",
      metadata: { path: ["sourceSha256"], equals: sha },
    },
    orderBy: { createdAt: "asc" },
  });

const byEmail = (email: string) => prisma.user.findUnique({ where: { email } });

const heldKeys = async (userId: string) =>
  (
    await prisma.userPosition.findMany({
      where: { userId },
      select: { position: { select: { key: true } } },
    })
  )
    .map((held) => held.position.key)
    .sort();

describe("applyImport against the database", () => {
  it(
    "creates users, credential accounts and positions, and audits once",
    async () => {
      const position = await createPosition();
      const user = exportUser({ admin_role: "Comptroller" });
      const source = sourceOf([user]);

      const plan = await apply(source, {
        "admin_role:Comptroller": [position.key],
      });

      expect(plan.counts).toMatchObject({ create: 1, positionsAssigned: 1 });
      const created = await byEmail(user.email);
      expect(created).toMatchObject({
        name: user.full_name,
        status: "ACTIVE",
        emailVerified: true,
      });
      const account = await prisma.account.findFirstOrThrow({
        where: { userId: created!.id, providerId: "credential" },
      });
      expect(account).toMatchObject({
        accountId: created!.id,
        password: `bcrypt$${user.password_hash}`,
      });
      // Only the first sign-in re-hash sets it.
      expect(created!.passwordChangedAt).toBeNull();
      expect(await heldKeys(created!.id)).toEqual([position.key]);
      expect(
        (
          await prisma.userPosition.findMany({ where: { userId: created!.id } })
        )[0].assignedById,
      ).toBeNull();

      const events = await auditEvents(source.sha);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({
        actorType: "SYSTEM",
        actorUserId: null,
        targetType: null,
        metadata: {
          source: "chambers",
          exportSource: "chambers-neon",
          created: 1,
          merged: 0,
          skipped: 0,
          positionsAssigned: 1,
          replacementsSha256: null,
        },
      });
      expect(JSON.stringify(events[0].metadata)).not.toContain(user.email);
      expect(JSON.stringify(events[0].metadata)).not.toContain("bcrypt");
    },
    TIMEOUT,
  );

  it(
    "gives a body's Leadership and Member users their own positions",
    async () => {
      const [director, member] = await Promise.all([
        createPosition(),
        createPosition(),
      ]);
      const body = randomUUID();
      const leader = exportUser({
        board_memberships: [membership(body, "Leadership")],
      });
      const seat = exportUser({
        board_memberships: [membership(body, "Member")],
      });

      await apply(sourceOf([leader, seat]), {
        [`board:${body}:Leadership`]: [director.key],
        [`board:${body}:Member`]: [member.key],
      });

      expect(await heldKeys((await byEmail(leader.email))!.id)).toEqual([
        director.key,
      ]);
      expect(await heldKeys((await byEmail(seat.email))!.id)).toEqual([
        member.key,
      ]);
    },
    TIMEOUT,
  );

  it(
    "is idempotent: a second apply creates and writes nothing",
    async () => {
      const position = await createPosition();
      const users = [
        exportUser({ admin_role: "Comptroller" }),
        exportUser({ password_hash: null }),
      ];
      const source = sourceOf(users);
      const roles = { "admin_role:Comptroller": [position.key] };

      await apply(source, roles);
      const before = await prisma.user.findMany({
        where: { email: { in: users.map((u) => u.email) } },
        orderBy: { email: "asc" },
      });
      const second = await apply(source, roles);
      const after = await prisma.user.findMany({
        where: { email: { in: users.map((u) => u.email) } },
        orderBy: { email: "asc" },
      });

      expect(second.counts).toMatchObject({
        create: 0,
        merge: 0,
        unchanged: 2,
        positionsAssigned: 0,
      });
      expect(after.map((u) => u.updatedAt)).toEqual(
        before.map((u) => u.updatedAt),
      );
      const events = await auditEvents(source.sha);
      expect(events).toHaveLength(2);
      expect(events[1].metadata).toMatchObject({ created: 0, unchanged: 2 });
    },
    TIMEOUT,
  );

  it(
    "merges into an existing user: keeps their password, adds positions",
    async () => {
      const position = await createPosition();
      const existing = await createUser({
        password: "an existing password",
        emailVerified: false,
      });
      const before = await prisma.account.findFirstOrThrow({
        where: { userId: existing.id, providerId: "credential" },
      });

      const plan = await apply(
        sourceOf([
          exportUser({
            email: existing.email,
            full_name: "A Different Name",
            admin_role: "Comptroller",
          }),
        ]),
        { "admin_role:Comptroller": [position.key] },
      );

      expect(plan.counts).toMatchObject({ create: 0, merge: 1 });
      const after = await prisma.account.findFirstOrThrow({
        where: { userId: existing.id, providerId: "credential" },
      });
      expect(after.password).toBe(before.password);
      expect(await heldKeys(existing.id)).toEqual([position.key]);
      expect(await byEmail(existing.email)).toMatchObject({
        name: existing.name,
        emailVerified: true,
      });
    },
    TIMEOUT,
  );

  it(
    "imports a replaced address unverified, and skips an unreplaced one",
    async () => {
      const replaced = exportUser({ email: `old-${suffix}@gmail.com` });
      const unreplaced = exportUser({ email: `lost-${suffix}@gmail.com` });
      const newEmail = `new-${suffix}@northeastern.edu`;
      const source = sourceOf([replaced, unreplaced]);

      const plan = await apply(
        source,
        {},
        replacementsOf({ [replaced.email]: newEmail }),
      );

      expect(plan.counts).toMatchObject({
        create: 1,
        skip: 1,
        nonNortheastern: 1,
        emailsReplaced: 1,
      });
      expect(await byEmail(newEmail)).toMatchObject({
        emailVerified: false,
        name: replaced.full_name,
      });
      expect(await byEmail(replaced.email)).toBeNull();
      expect(await byEmail(unreplaced.email)).toBeNull();
      expect((await auditEvents(source.sha))[0].metadata).toMatchObject({
        skipped: 1,
        emailsReplaced: 1,
      });
    },
    TIMEOUT,
  );

  it(
    "merges a replacement that targets an existing user without changing them",
    async () => {
      const existing = await createUser({
        name: "Existing Name",
        status: "DEACTIVATED",
        emailVerified: false,
      });
      const row = exportUser({
        email: `elsewhere-${suffix}-${counter}@gmail.com`,
        full_name: "Chambers Name",
      });

      await apply(
        sourceOf([row]),
        {},
        replacementsOf({ [row.email]: existing.email }),
      );

      expect(await byEmail(existing.email)).toMatchObject({
        name: "Existing Name",
        status: "DEACTIVATED",
        emailVerified: false,
      });
      expect(
        await prisma.account.count({
          where: { userId: existing.id, providerId: "credential" },
        }),
      ).toBe(1);
    },
    TIMEOUT,
  );

  it(
    "creates a user with no hash and no credential account",
    async () => {
      const user = exportUser({ password_hash: null });
      await apply(sourceOf([user]), {});
      const created = await byEmail(user.email);
      expect(created).not.toBeNull();
      expect(
        await prisma.account.count({ where: { userId: created!.id } }),
      ).toBe(0);
    },
    TIMEOUT,
  );

  it(
    "creates an inactive Chambers user deactivated, with no positions",
    async () => {
      const position = await createPosition();
      const user = exportUser({ is_active: false, admin_role: "Comptroller" });
      await apply(sourceOf([user]), {
        "admin_role:Comptroller": [position.key],
      });
      const created = await byEmail(user.email);
      expect(created).toMatchObject({ status: "DEACTIVATED" });
      expect(created!.deactivatedAt).not.toBeNull();
      expect(await heldKeys(created!.id)).toEqual([]);
    },
    TIMEOUT,
  );

  it(
    "writes nothing in a dry run",
    async () => {
      const position = await createPosition();
      const user = exportUser({ admin_role: "Comptroller" });
      const source = sourceOf([user]);
      const mapping = mappingOf({ "admin_role:Comptroller": [position.key] });
      const rows = source.data.users.map((u) => toImportRow(u, new Map(), NOW));

      const plan = planImport(
        rows,
        "chambers-neon",
        mapping,
        new Map(),
        await readImportState(prisma, rows, mapping),
      );

      expect(plan.counts.create).toBe(1);
      expect(await byEmail(user.email)).toBeNull();
      expect(await auditEvents(source.sha)).toHaveLength(0);
    },
    TIMEOUT,
  );

  it(
    "aborts before any write on an unknown mapped key",
    async () => {
      const user = exportUser({ admin_role: "Comptroller" });
      const source = sourceOf([user]);

      await expect(
        apply(source, { "admin_role:Comptroller": [`ghost-${suffix}`] }),
      ).rejects.toThrow(ImportInputError);

      expect(await byEmail(user.email)).toBeNull();
      expect(await auditEvents(source.sha)).toHaveLength(0);
    },
    TIMEOUT,
  );
});
