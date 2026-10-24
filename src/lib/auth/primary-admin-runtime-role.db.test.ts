import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  ensureHarnessPrimaryAdmin,
  HARNESS_PRIMARY_ADMIN_EMAIL,
} from "@/test/harness-primary-admin";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;

const INSUFFICIENT_PRIVILEGE = "42501";

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

// Layer 3: raw SQL as the runtime role. Every statement runs inside
// BEGIN ... ROLLBACK, so an unexpected success still changes nothing.
describe.skipIf(!url)("primary admin protection: runtime role SQL", () => {
  const client = new Client({ connectionString: url });
  let owner = "";
  let primaryAdminId = "";

  beforeAll(async () => {
    await client.connect();
    const { rows } = await client.query<{ tableowner: string }>(
      `SELECT tableowner FROM pg_tables WHERE schemaname = 'public' AND tablename = 'User'`,
    );
    owner = rows[0].tableowner;
    const user = await ensureHarnessPrimaryAdmin({
      password: "runtime-role-pass-1",
    });
    primaryAdminId = user.id;
  });

  afterAll(async () => {
    await client.end();
  });

  async function inRollback(fn: () => Promise<void>) {
    await client.query("BEGIN");
    try {
      await fn();
    } finally {
      await client.query("ROLLBACK");
    }
  }

  // Runs a statement that must fail inside a savepoint, so one test can assert
  // several rejections in the same transaction.
  async function expectSqlError(sql: string, check: (error: Error) => void) {
    await client.query("SAVEPOINT expect_error");
    try {
      const outcome = await client.query(sql).then(
        () => null,
        (error: unknown) => error,
      );
      expect(outcome, `${sql} unexpectedly succeeded`).toBeInstanceOf(Error);
      check(outcome as Error);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT expect_error");
    }
  }

  const expectPrivilegeError = (sql: string) =>
    expectSqlError(sql, (error) =>
      expect((error as Error & { code?: string }).code).toBe(
        INSUFFICIENT_PRIVILEGE,
      ),
    );

  // A privilege test that silently passes as the owner proves nothing. Postgres
  // lets either the table owner or the schema owner DROP an index, so both are
  // excluded: a role that is a member of the public schema's owner (for example
  // the Neon database owner, through pg_database_owner) can drop
  // one_primary_admin without owning the table.
  it("runs as the runtime role, not the table or schema owner", async () => {
    const { rows } = await client.query<{
      current_user: string;
      table_member: boolean;
      schema_member: boolean;
    }>(
      `SELECT current_user,
              pg_has_role(current_user, $1, 'MEMBER') AS table_member,
              pg_has_role(
                current_user,
                (SELECT nspowner FROM pg_namespace WHERE nspname = 'public'),
                'MEMBER'
              ) AS schema_member`,
      [owner],
    );
    expect(
      rows[0].current_user !== owner &&
        !rows[0].table_member &&
        !rows[0].schema_member,
      "TEST_DATABASE_URL must use the runtime role, not the table owner or a member of the public schema's owner (see CONTRIBUTING.md)",
    ).toBe(true);
  });

  it("cannot disable, drop or replace the guard", async () => {
    await inRollback(async () => {
      for (const sql of [
        `ALTER TABLE "User" DISABLE TRIGGER protect_primary_admin`,
        `ALTER TABLE "User" DISABLE TRIGGER ALL`,
        `DROP TRIGGER protect_primary_admin ON "User"`,
        `DROP TRIGGER primary_admin_must_exist ON "User"`,
        `CREATE OR REPLACE FUNCTION protect_primary_admin() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RETURN NEW; END $$`,
        `DROP INDEX one_primary_admin`,
        `ALTER TABLE "User" DROP CONSTRAINT "User_primaryAdmin_requires_admin"`,
      ]) {
        await expectPrivilegeError(sql);
      }
    });
  });

  it("cannot skip the triggers or become the owner", async () => {
    await inRollback(async () => {
      // TRUNCATE does not fire row triggers.
      await expectPrivilegeError(`TRUNCATE "User" CASCADE`);
      // Would silence every trigger.
      await expectPrivilegeError(
        `SET LOCAL session_replication_role = replica`,
      );
      await expectPrivilegeError(`SET LOCAL ROLE ${quote(owner)}`);
    });
  });

  it("still cannot delete, deactivate or de-admin the Primary Admin with the transfer variable on", async () => {
    // Any role can set the variable, so it must not unlock these three.
    const { rows } = await client.query<{ id: string; email: string }>(
      `SELECT "id", "email" FROM "User" WHERE "isPrimaryAdmin"`,
    );
    expect(rows).toEqual([
      { id: primaryAdminId, email: HARNESS_PRIMARY_ADMIN_EMAIL },
    ]);

    await inRollback(async () => {
      await client.query(`SELECT set_config('sgauth.pa_transfer', 'on', true)`);
      const rejected = (fragment: string) => (error: Error) =>
        expect(error.message).toContain(fragment);
      await expectSqlError(
        `DELETE FROM "User" WHERE "id" = '${primaryAdminId}'`,
        rejected("cannot be deleted"),
      );
      await expectSqlError(
        `UPDATE "User" SET "status" = 'DEACTIVATED' WHERE "id" = '${primaryAdminId}'`,
        rejected("must remain an active admin"),
      );
      await expectSqlError(
        `UPDATE "User" SET "isAdmin" = false WHERE "id" = '${primaryAdminId}'`,
        rejected("must remain an active admin"),
      );
    });
  });
});
