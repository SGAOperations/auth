import "server-only";
import { auth } from "@/lib/auth/server";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { createRateLimiter } from "@/lib/rate-limit/limiter";
import { createMemoryBackend } from "@/lib/rate-limit/memory-backend";
import {
  buildSessionEndpointDeps,
  createSessionEndpoint,
} from "@/lib/sgauth-session/handler";

// Always in memory, never Upstash: this is a hot path, so it makes no Redis
// call (docs/RATE-LIMITING.md). Limits are per instance.
const limiter = createRateLimiter({
  backend: createMemoryBackend(),
  log: logger,
});

export const sessionEndpoint = createSessionEndpoint(
  buildSessionEndpointDeps({ auth, prisma, limiter }),
);
