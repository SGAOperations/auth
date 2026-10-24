import "server-only";
import { env } from "@/lib/env";
import type { HealthProbes } from "@/lib/health/checks";
import { prisma } from "@/lib/prisma";

const VERSION_LENGTH = 7;

export const probes: HealthProbes = {
  async pingDb() {
    await prisma.$queryRaw`SELECT 1`;
  },
  // Reads only `id`, never the private key column.
  async hasJwksKey() {
    return (await prisma.jwks.findFirst({ select: { id: true } })) !== null;
  },
  version: env.VERCEL_GIT_COMMIT_SHA?.slice(0, VERSION_LENGTH) ?? "local",
};
