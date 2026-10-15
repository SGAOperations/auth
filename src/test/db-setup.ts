import { Client } from "pg";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

// pg_trigger.tgtype bit for TRUNCATE triggers.
const TRIGGER_TYPE_TRUNCATE = 32;

async function truncateAllTables(client: Client) {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  if (tables.rows.length === 0) return;

  // Some tables reject TRUNCATE on purpose (AuditEvent is append-only). Switch
  // those triggers off for this one transaction only, so a failure rolls the
  // whole thing back with the triggers still in place.
  const guards = await client.query<{ tablename: string; trigger: string }>(
    `SELECT c.relname AS tablename, t.tgname AS trigger
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND (t.tgtype & ${TRIGGER_TYPE_TRUNCATE}) <> 0`,
  );
  const alter = (action: "DISABLE" | "ENABLE") =>
    guards.rows.map(
      ({ tablename, trigger }) =>
        `ALTER TABLE ${quote(tablename)} ${action} TRIGGER ${quote(trigger)}`,
    );

  await client.query("BEGIN");
  try {
    for (const statement of alter("DISABLE")) await client.query(statement);
    await client.query(
      `TRUNCATE ${tables.rows.map((row) => quote(row.tablename)).join(", ")} RESTART IDENTITY CASCADE`,
    );
    for (const statement of alter("ENABLE")) await client.query(statement);
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Truncation goes over the direct (migration role) URL: the runtime role
// behind the pooled URL has no TRUNCATE privilege and does not own the
// tables. The db project maps TEST_DIRECT_URL onto DIRECT_URL for the workers.
beforeAll(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    await truncateAllTables(client);
  } finally {
    await client.end();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

afterAll(async () => {
  await prisma.$disconnect();
});
