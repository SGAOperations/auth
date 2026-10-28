import type { NextRequest } from "next/server";
import { liveAdminUserHandlers } from "@/lib/admin/users/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/users";

const ctx = { params: Promise.resolve({}) };

// The logic lives in src/lib/admin/users; this file only binds it.
export const GET = (request: NextRequest) =>
  withRequestLogging(
    ROUTE,
    (req) => liveAdminUserHandlers.list(req, ctx),
    logger,
  )(request);

export const POST = (request: NextRequest) =>
  withRequestLogging(
    ROUTE,
    (req) => liveAdminUserHandlers.create(req, ctx),
    logger,
  )(request);
