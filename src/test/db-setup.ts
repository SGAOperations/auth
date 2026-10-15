import { Client } from "pg";
import { afterAll, afterEach, beforeAll, vi } from "vitest";
import { prisma } from "@/lib/prisma";

const quote = (identifier: string) => `"${identifier.replaceAll('"', '""')}"`;

// pg_trigger.tgtype bit for TRUNCATE triggers.
const TRIGGER_TYPE_TRUNCATE = 32;

// Orders tables so every table comes before the tables it references: deleting
// in this order never trips a RESTRICT foreign key. Self references are
// ignored; a cycle falls through in alphabetical order and surfaces as a
// foreign key error rather than silently skipping a table.
function childrenFirst(
  tables: string[],
  edges: { child: string; parent: string }[],
): string[] {
  const remaining = new Set(tables);
  const ordered: string[] = [];
  while (remaining.size > 0) {
    const ready = [...remaining].filter(
      (table) =>
        !edges.some(
          ({ child, parent }) =>
            parent === table && child !== table && remaining.has(child),
        ),
    );
    const batch = ready.length > 0 ? ready : [...remaining].slice(0, 1);
    for (const table of batch) {
      ordered.push(table);
      remaining.delete(table);
    }
  }
  return ordered;
}

// Empties every table the harness is able to reset. The role behind
// TEST_DIRECT_URL does not own the tables (the migration role does) and holds
// no TRUNCATE privilege, so this uses DELETE, which it does have.
//
// Tables guarded by a TRUNCATE trigger are append-only by design (AuditEvent)
// and reject DELETE as well, so they are left alone. Tests that write to them
// must filter by their own ids rather than assume an empty table.
async function resetTables(client: Client) {
  const tables = await client.query<{ tablename: string }>(
    `SELECT tablename FROM pg_tables
     WHERE schemaname = 'public' AND tablename <> '_prisma_migrations'`,
  );
  const guarded = await client.query<{ tablename: string }>(
    `SELECT DISTINCT c.relname AS tablename
     FROM pg_trigger t
     JOIN pg_class c ON c.oid = t.tgrelid
     JOIN pg_namespace n ON n.oid = c.relnamespace
     WHERE n.nspname = 'public' AND NOT t.tgisinternal
       AND (t.tgtype & ${TRIGGER_TYPE_TRUNCATE}) <> 0`,
  );
  const skip = new Set(guarded.rows.map((row) => row.tablename));
  const resettable = tables.rows
    .map((row) => row.tablename)
    .filter((name) => !skip.has(name));
  if (resettable.length === 0) return;

  const foreignKeys = await client.query<{ child: string; parent: string }>(
    `SELECT child.relname AS child, parent.relname AS parent
     FROM pg_constraint con
     JOIN pg_class child ON child.oid = con.conrelid
     JOIN pg_class parent ON parent.oid = con.confrelid
     JOIN pg_namespace n ON n.oid = child.relnamespace
     WHERE con.contype = 'f' AND n.nspname = 'public'`,
  );

  await client.query("BEGIN");
  try {
    for (const table of childrenFirst(resettable, foreignKeys.rows)) {
      await client.query(`DELETE FROM ${quote(table)}`);
    }
    await client.query("COMMIT");
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  }
}

// Reset goes over the direct (migration) URL: the runtime role behind the
// pooled URL cannot delete everything. The db project maps TEST_DIRECT_URL
// onto DIRECT_URL for the workers.
beforeAll(async () => {
  const client = new Client({ connectionString: process.env.DIRECT_URL });
  await client.connect();
  try {
    await resetTables(client);
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
