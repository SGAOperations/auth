import "server-only";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

// Pool sizing per Vercel function instance. The Neon pooler absorbs fan-out
// across instances, so each one needs only a few connections. The short idle
// timeout releases connections so an idle compute can suspend, and the connect
// timeout fails fast instead of waiting forever (pg's default) on a stuck
// connect.
const POOL_MAX = 5;
const POOL_IDLE_TIMEOUT_MS = 10_000;
const POOL_CONNECTION_TIMEOUT_MS = 5_000;

function createPrismaClient() {
  // adapter-pg (TCP) rather than adapter-neon: SGAuth runs on the Vercel Node
  // runtime, not Edge, so no WebSocket transport is needed.
  const adapter = new PrismaPg(
    {
      connectionString: process.env.DATABASE_URL,
      max: POOL_MAX,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    },
    {
      // Idle sockets can be dropped by the pooler or a suspending compute. An
      // unhandled pool error event would crash the function. Log the error
      // only, never the connection string.
      onPoolError: (err) => console.error("[prisma] pg pool error", err),
    },
  );
  return new PrismaClient({ adapter, errorFormat: "minimal" });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (process.env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
