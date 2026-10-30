import { AsyncLocalStorage } from "node:async_hooks";
import type { Prisma, PrismaClient } from "@/generated/prisma/client";

// A test case that runs in one database transaction and rolls it back, while
// the route handlers under test still open transactions of their own on
// `@/lib/prisma`. A Primary Admin can never be committed (src/test/db-setup.ts),
// so any case that needs one has to run this way.
//
// Wire it once per test file, before the route modules are imported:
//
//   vi.mock("@/lib/prisma", async (importOriginal) => {
//     const { prisma } = await importOriginal<typeof import("@/lib/prisma")>();
//     const { createRollbackPrisma } = await import("@/test/rollback-prisma");
//     return { prisma: createRollbackPrisma(prisma) };
//   });
//
// Outside `withRollback` the proxy forwards every call unchanged.

type Tx = Prisma.TransactionClient;

/** Thrown after the case ends so the outer transaction never commits. */
class Rollback extends Error {
  constructor() {
    super("rollback");
    this.name = "Rollback";
  }
}

// In production a SET LOCAL ends with its transaction. Here the outer
// transaction outlives every handler transaction, so a setting a handler left
// on would leak into the rest of the case and hide a missing gate. Each is
// cleared after every nested transaction.
const TX_LOCAL_SETTINGS = ["sgauth.pa_transfer", "sgauth.audit_anonymize"];

const current = new AsyncLocalStorage<Tx>();
let client: PrismaClient | undefined;
let savepointCount = 0;

async function runNested(tx: Tx, work: unknown): Promise<unknown> {
  savepointCount += 1;
  const name = `sgauth_test_sp_${savepointCount}`;
  await tx.$executeRawUnsafe(`SAVEPOINT ${name}`);
  try {
    let result: unknown;
    if (Array.isArray(work)) {
      // The array form: each item is a lazy Prisma promise, run in order.
      const results: unknown[] = [];
      for (const item of work as PromiseLike<unknown>[]) {
        results.push(await item);
      }
      result = results;
    } else {
      result = await (work as (tx: Tx) => Promise<unknown>)(tx);
    }
    await tx.$executeRawUnsafe(`RELEASE SAVEPOINT ${name}`);
    for (const setting of TX_LOCAL_SETTINGS) {
      await tx.$executeRawUnsafe(`SELECT set_config('${setting}', '', true)`);
    }
    return result;
  } catch (error) {
    await tx.$executeRawUnsafe(`ROLLBACK TO SAVEPOINT ${name}`);
    throw error;
  }
}

/**
 * Wraps the real client. Inside `withRollback`, every call goes to the case's
 * transaction and `$transaction` becomes a savepoint, so a handler's own
 * conflict sentinel or failed audit write rolls back exactly what it would in
 * production. The `timeout`, `maxWait` and `isolationLevel` options of the
 * nested call are ignored: the outer transaction decides them.
 */
export function createRollbackPrisma(real: PrismaClient): PrismaClient {
  client = real;
  return new Proxy(real, {
    get(target, key) {
      const tx = current.getStore();
      if (tx && key === "$transaction") {
        return (work: unknown) => runNested(tx, work);
      }
      const source: object = tx ?? target;
      const value: unknown = Reflect.get(source, key);
      return typeof value === "function"
        ? (value as (...args: unknown[]) => unknown).bind(source)
        : value;
    },
  });
}

/**
 * Runs `body` inside one transaction on the real client and rolls it back
 * afterwards, whether `body` returns or throws. Anything `body` throws other
 * than the rollback itself is rethrown.
 */
export async function withRollback(
  body: () => Promise<void>,
  { timeout = 90_000 }: { timeout?: number } = {},
): Promise<void> {
  if (!client) {
    throw new Error(
      "withRollback needs createRollbackPrisma: mock @/lib/prisma with it first",
    );
  }
  await client
    .$transaction(
      async (tx) => {
        await current.run(tx, body);
        throw new Rollback();
      },
      { timeout, maxWait: 30_000 },
    )
    .catch((error: unknown) => {
      if (!(error instanceof Rollback)) throw error;
    });
}

/**
 * Fires every deferred constraint trigger now, such as
 * `primary_admin_must_exist`, which would otherwise run at a commit that never
 * happens.
 */
export async function assertDeferredConstraints(): Promise<void> {
  const tx = current.getStore();
  if (!tx)
    throw new Error("assertDeferredConstraints runs inside withRollback");
  await tx.$executeRawUnsafe("SET CONSTRAINTS ALL IMMEDIATE");
}
