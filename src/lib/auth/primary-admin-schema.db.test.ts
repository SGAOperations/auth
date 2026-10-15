import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const url = process.env.TEST_DATABASE_URL;
// eslint-disable-next-line no-restricted-syntax -- test-only variable, deliberately outside the app env schema
const directUrl = process.env.TEST_DIRECT_URL;

const DAY_MS = 24 * 60 * 60 * 1000;
const DOWN_SQL = resolve(
  process.cwd(),
  "prisma/migrations/20261016000000_primary_admin_invariants/down.sql",
);

type Status = "ACTIVE" | "DEACTIVATED" | "DELETED";

// SQL-level tests: each case runs inside BEGIN ... ROLLBACK, so nothing persists
// and the deferred trigger never reaches a commit. They also never collide with
// a Primary Admin that already exists in the shared test database.
describe.skipIf(!url)("primary admin database invariants", () => {
  let client = new Client({ connectionString: url });
  const rand = Math.random().toString(36).slice(2, 10);

  beforeAll(async () => {
    await client.connect();
  });

  afterAll(async () => {
    await client.end();
  });

  async function insertUser(
    options: {
      isAdmin?: boolean;
      isPrimaryAdmin?: boolean;
      status?: Status;
    } = {},
  ): Promise<string> {
    const id = randomUUID();
    await client.query(
      `INSERT INTO "User" ("id", "email", "name", "isAdmin", "isPrimaryAdmin", "status", "updatedAt")
       VALUES ($1, $2, 'Fixture', $3, $4, $5::"UserStatus", CURRENT_TIMESTAMP)`,
      [
        id,
        `pa-${rand}-${id}@fixture.invalid`,
        options.isAdmin ?? false,
        options.isPrimaryAdmin ?? false,
        options.status ?? "ACTIVE",
      ],
    );
    return id;
  }

  async function setTransferVariable(value: string) {
    await client.query("SELECT set_config('sgauth.pa_transfer', $1, true)", [
      value,
    ]);
  }

  // Opens a transaction holding exactly one Primary Admin (a fresh fixture),
  // runs fn with its id, and always rolls back.
  async function inRollback(fn: (primaryAdminId: string) => Promise<void>) {
    await client.query("BEGIN");
    try {
      await setTransferVariable("on");
      await client.query(
        `UPDATE "User" SET "isPrimaryAdmin" = false WHERE "isPrimaryAdmin"`,
      );
      await setTransferVariable("off");
      const primaryAdminId = await insertUser({
        isAdmin: true,
        isPrimaryAdmin: true,
      });
      await fn(primaryAdminId);
    } finally {
      await client.query("ROLLBACK");
    }
  }

  // Runs a statement that must fail inside a savepoint, so one test can assert
  // several rejections in the same transaction.
  async function expectSqlError(
    sql: string,
    params: unknown[],
    fragment: string,
  ) {
    await client.query("SAVEPOINT expect_error");
    try {
      await expect(client.query(sql, params)).rejects.toThrow(fragment);
    } finally {
      await client.query("ROLLBACK TO SAVEPOINT expect_error");
    }
  }

  async function primaryAdminIds(): Promise<string[]> {
    const { rows } = await client.query<{ id: string }>(
      `SELECT "id" FROM "User" WHERE "isPrimaryAdmin"`,
    );
    return rows.map((row) => row.id);
  }

  const insertTransfer = `INSERT INTO "PrimaryAdminTransfer" ("id", "fromUserId", "toUserId", "status")
     VALUES ($1, $2, $3, $4::"PrimaryAdminTransferStatus")`;

  it("rejects a second Primary Admin", async () => {
    await inRollback(async () => {
      await expectSqlError(
        `INSERT INTO "User" ("id", "email", "name", "isAdmin", "isPrimaryAdmin", "updatedAt")
         VALUES ($1, $2, 'Second', true, true, CURRENT_TIMESTAMP)`,
        [randomUUID(), `pa-second-${rand}@fixture.invalid`],
        "one_primary_admin",
      );
    });
  });

  it("rejects demoting, deactivating or tombstoning the Primary Admin", async () => {
    await inRollback(async (paId) => {
      await expectSqlError(
        `UPDATE "User" SET "isAdmin" = false WHERE "id" = $1`,
        [paId],
        "must remain an active admin",
      );
      await expectSqlError(
        `UPDATE "User" SET "status" = 'DEACTIVATED' WHERE "id" = $1`,
        [paId],
        "must remain an active admin",
      );
      await expectSqlError(
        `UPDATE "User" SET "status" = 'DELETED' WHERE "id" = $1`,
        [paId],
        "must remain an active admin",
      );
    });
  });

  it("keeps rejecting those changes while the transfer variable is set", async () => {
    await inRollback(async (paId) => {
      await setTransferVariable("on");
      await expectSqlError(
        `UPDATE "User" SET "status" = 'DEACTIVATED' WHERE "id" = $1`,
        [paId],
        "must remain an active admin",
      );
      await expectSqlError(
        `DELETE FROM "User" WHERE "id" = $1`,
        [paId],
        "cannot be deleted",
      );
    });
  });

  it("rejects promoting a deactivated admin to Primary Admin", async () => {
    await inRollback(async () => {
      await setTransferVariable("on");
      await client.query(
        `UPDATE "User" SET "isPrimaryAdmin" = false WHERE "isPrimaryAdmin"`,
      );
      const id = await insertUser({ isAdmin: true, status: "DEACTIVATED" });
      await expectSqlError(
        `UPDATE "User" SET "isPrimaryAdmin" = true WHERE "id" = $1`,
        [id],
        "must remain an active admin",
      );
    });
  });

  it("rejects deleting the Primary Admin", async () => {
    await inRollback(async (paId) => {
      await expectSqlError(
        `DELETE FROM "User" WHERE "id" = $1`,
        [paId],
        "cannot be deleted",
      );
    });
  });

  it("still allows updating and deleting a non-Primary-Admin user", async () => {
    await inRollback(async () => {
      const id = await insertUser({ isAdmin: true });
      const update = await client.query(
        `UPDATE "User" SET "isAdmin" = false, "status" = 'DEACTIVATED' WHERE "id" = $1`,
        [id],
      );
      expect(update.rowCount).toBe(1);
      const remove = await client.query(`DELETE FROM "User" WHERE "id" = $1`, [
        id,
      ]);
      expect(remove.rowCount).toBe(1);
    });
  });

  it("rejects clearing isPrimaryAdmin unless the variable is on", async () => {
    await inRollback(async (paId) => {
      const clear = `UPDATE "User" SET "isPrimaryAdmin" = false WHERE "id" = $1`;
      const fragment = "requires sgauth.pa_transfer";
      // inRollback left the variable at 'off'.
      await expectSqlError(clear, [paId], fragment);
      await setTransferVariable("");
      await expectSqlError(clear, [paId], fragment);
    });
    // Unset: a fresh transaction on a connection that never set it.
    await inRollback(async (paId) => {
      await client.query("RESET sgauth.pa_transfer");
      await expectSqlError(
        `UPDATE "User" SET "isPrimaryAdmin" = false WHERE "id" = $1`,
        [paId],
        "requires sgauth.pa_transfer",
      );
    });
  });

  it("transfers the Primary Admin inside a transaction with the variable set", async () => {
    await inRollback(async (oldId) => {
      const newId = await insertUser({ isAdmin: true });
      await setTransferVariable("on");
      await client.query(
        `UPDATE "User" SET "isPrimaryAdmin" = false WHERE "id" = $1`,
        [oldId],
      );
      await client.query(
        `UPDATE "User" SET "isPrimaryAdmin" = true WHERE "id" = $1`,
        [newId],
      );
      await client.query("SET CONSTRAINTS primary_admin_must_exist IMMEDIATE");

      expect(await primaryAdminIds()).toEqual([newId]);
      const { rows } = await client.query<{ isAdmin: boolean }>(
        `SELECT "isAdmin" FROM "User" WHERE "id" = ANY($1)`,
        [[oldId, newId]],
      );
      expect(rows).toEqual([{ isAdmin: true }, { isAdmin: true }]);
    });
  });

  it("rejects a transfer that clears the Primary Admin without setting a new one", async () => {
    await inRollback(async (paId) => {
      await setTransferVariable("on");
      await client.query(
        `UPDATE "User" SET "isPrimaryAdmin" = false WHERE "id" = $1`,
        [paId],
      );
      await expectSqlError(
        "SET CONSTRAINTS primary_admin_must_exist IMMEDIATE",
        [],
        "primary_admin_must_exist",
      );
    });
  });

  it("scopes the transfer variable to the transaction", async () => {
    await client.query("BEGIN");
    await setTransferVariable("on");
    await client.query("ROLLBACK");
    const { rows } = await client.query<{ value: string | null }>(
      "SELECT current_setting('sgauth.pa_transfer', true) AS value",
    );
    expect(rows[0].value ?? "").toBe("");
  });

  it("allows at most one in-flight transfer", async () => {
    await inRollback(async () => {
      const from = await insertUser({ isAdmin: true });
      const to = await insertUser({ isAdmin: true });
      const insert = (status: string) =>
        client.query(insertTransfer, [randomUUID(), from, to, status]);

      await insert("PENDING_ACCEPTANCE");
      for (const status of ["PENDING_ACCEPTANCE", "COOLING"]) {
        await expectSqlError(
          insertTransfer,
          [randomUUID(), from, to, status],
          "one_in_flight_primary_admin_transfer",
        );
      }
      for (const status of ["COMPLETED", "CANCELLED", "EXPIRED"]) {
        await insert(status);
      }
      const { rows } = await client.query<{ count: string }>(
        `SELECT count(*) FROM "PrimaryAdminTransfer" WHERE "fromUserId" = $1`,
        [from],
      );
      expect(Number(rows[0].count)).toBe(4);
    });
  });

  it("defaults acceptanceExpiresAt to seven days and rejects self-transfer", async () => {
    await inRollback(async () => {
      const from = await insertUser({ isAdmin: true });
      const to = await insertUser({ isAdmin: true });
      const id = randomUUID();
      await client.query(insertTransfer, [id, from, to, "PENDING_ACCEPTANCE"]);
      const { rows } = await client.query<{ span: number }>(
        `SELECT extract(epoch FROM "acceptanceExpiresAt" - "createdAt") * 1000 AS span
         FROM "PrimaryAdminTransfer" WHERE "id" = $1`,
        [id],
      );
      expect(Math.abs(Number(rows[0].span) - 7 * DAY_MS)).toBeLessThan(5000);

      await expectSqlError(
        insertTransfer,
        [randomUUID(), from, from, "COMPLETED"],
        "PrimaryAdminTransfer_distinct_parties",
      );
    });
  });

  // down.sql drops triggers, functions and tables, which only their owner may
  // do. The runtime role behind TEST_DATABASE_URL is not the owner, so this one
  // test runs on the migration role behind TEST_DIRECT_URL. That role must own
  // the tables (it ran `migrate deploy`); if the test branch was migrated by a
  // different role, reset the branch so the migration role owns everything.
  it.skipIf(!directUrl)("is fully reversed by down.sql", async () => {
    const down = readFileSync(DOWN_SQL, "utf8");
    const runtime = client;
    client = new Client({ connectionString: directUrl });
    await client.connect();
    try {
      await runDownSql(down);
    } finally {
      await client.end();
      client = runtime;
    }
  });

  async function runDownSql(down: string) {
    await inRollback(async () => {
      await client.query(down);

      const { rows } = await client.query<{ gone: boolean }>(
        `SELECT
           to_regclass('"PrimaryAdminTransfer"') IS NULL
           AND NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'PrimaryAdminTransferStatus')
           AND NOT EXISTS (
             SELECT 1 FROM pg_trigger
             WHERE tgname IN ('protect_primary_admin', 'primary_admin_must_exist')
           )
           AND NOT EXISTS (
             SELECT 1 FROM pg_proc
             WHERE proname IN ('protect_primary_admin', 'require_primary_admin')
           )
           AND NOT EXISTS (SELECT 1 FROM pg_indexes WHERE indexname = 'one_primary_admin')
           AS gone`,
      );
      expect(rows[0].gone).toBe(true);

      // The unique index is gone, so a second Primary Admin now succeeds.
      await insertUser({ isAdmin: true, isPrimaryAdmin: true });
      expect(await primaryAdminIds()).toHaveLength(2);
    });
  }
});
