import "server-only";
import type { PrismaClient } from "@/generated/prisma/client";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { toAuthSettings } from "@/lib/auth/settings";
import { createProductRegistry } from "@/lib/product-registry";

export type { ActiveProduct } from "@/lib/product-registry";

export function loadActiveProducts(client: PrismaClient) {
  return client.product.findMany({
    where: { isActive: true },
    orderBy: [{ sortOrder: "asc" }, { slug: "asc" }],
    select: {
      slug: true,
      name: true,
      description: true,
      baseUrl: true,
      iconUrl: true,
      sortOrder: true,
      visibleToPositionKeys: true,
      loginRedirectPath: true,
    },
  });
}

const registry = createProductRegistry({
  loadActiveProducts: () => loadActiveProducts(prisma),
  ownOrigin: new URL(toAuthSettings(env).baseURL).origin,
  sgauthEnv: env.SGAUTH_ENV,
  log: logger,
});

export const getTrustedOrigins = registry.getTrustedOrigins;
export const isAllowedRedirect = registry.isAllowedRedirect;
export const getActiveProducts = registry.getActiveProducts;

/**
 * Product create, update and delete call this after their write commits.
 * Invalidation is per instance: other instances converge within 60 s.
 */
export const invalidateProductCache = registry.invalidate;
