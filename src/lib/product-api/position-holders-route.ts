import "server-only";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import {
  loadPositionHolders,
  positionHoldersBody,
} from "@/lib/position-holders";
import { prisma } from "@/lib/prisma";
import { createProductApiHandler } from "@/lib/product-api/handler";
import { authenticateProductKey } from "@/lib/product-api-keys";
import { limitRequest } from "@/lib/rate-limit/server";

/**
 * `POST /api/products/positions/holders` (#384). Who currently holds these
 * positions: active users only, read live. The product API key is the gate;
 * positions, names and emails are directory-level data. Reads only.
 */
export const positionHoldersRoute = withRequestLogging(
  "/api/products/positions/holders",
  createProductApiHandler({
    name: "product_api.position_holders",
    enabled: true,
    schema: positionHoldersBody,
    authenticate: (authorization) =>
      authenticateProductKey(prisma, authorization),
    limit: ({ productId }) => limitRequest("productApi", productId),
    log: logger,
    run: async (_product, input) => ({
      status: 200,
      body: await loadPositionHolders(prisma, input.keys),
    }),
  }),
  logger,
);
