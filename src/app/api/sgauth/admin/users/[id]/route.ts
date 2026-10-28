import type { NextRequest } from "next/server";
import { liveAdminUserHandlers } from "@/lib/admin/users/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/users/[id]";

type Ctx = { params: Promise<{ id: string }> };

// The logic lives in src/lib/admin/users; this file only binds it. The
// wrapper's handler takes only the request, so the context is closed over.
export const GET = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(
    ROUTE,
    (req) => liveAdminUserHandlers.get(req, ctx),
    logger,
  )(request);

export const PATCH = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(
    ROUTE,
    (req) => liveAdminUserHandlers.update(req, ctx),
    logger,
  )(request);

export const DELETE = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(
    ROUTE,
    (req) => liveAdminUserHandlers.remove(req, ctx),
    logger,
  )(request);
