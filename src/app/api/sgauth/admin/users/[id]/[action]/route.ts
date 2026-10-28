import type { NextRequest } from "next/server";
import { liveAdminUserHandlers } from "@/lib/admin/users/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/users/[id]/[action]";

type Ctx = { params: Promise<{ id: string; action: string }> };

// The logic lives in src/lib/admin/users; this file only binds it.
export const POST = (request: NextRequest, ctx: Ctx) =>
  withRequestLogging(
    ROUTE,
    (req) => liveAdminUserHandlers.action(req, ctx),
    logger,
  )(request);
