import "server-only";
import { PrismaClient } from "../generated/prisma/client";
import { PrismaPg } from "@prisma/adapter-pg";
import { env } from "@/lib/env";

const globalForPrisma = globalThis as unknown as {
  prisma?: PrismaClient;
};

// Per function instance: pooler absorbs fan-out, idle frees compute, connect fails fast.
const POOL_MAX = 5;
const POOL_IDLE_TIMEOUT_MS = 10_000;
const POOL_CONNECTION_TIMEOUT_MS = 5_000;

function createPrismaClient() {
  // adapter-pg (TCP), not adapter-neon: Node runtime, no WebSocket needed.
  const adapter = new PrismaPg(
    {
      connectionString: env.DATABASE_URL,
      max: POOL_MAX,
      idleTimeoutMillis: POOL_IDLE_TIMEOUT_MS,
      connectionTimeoutMillis: POOL_CONNECTION_TIMEOUT_MS,
    },
    {
      // Unhandled pool errors crash the function; log the error, never the URL.
      onPoolError: (err) => console.error("[prisma] pg pool error", err),
    },
  );
  return new PrismaClient({ adapter, errorFormat: "minimal" });
}

export const prisma = globalForPrisma.prisma ?? createPrismaClient();

if (env.NODE_ENV !== "production") {
  globalForPrisma.prisma = prisma;
}
