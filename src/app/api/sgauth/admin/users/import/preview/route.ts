import type { NextRequest } from "next/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { liveUserImportHandlers } from "@/lib/user-import/server";

export const runtime = "nodejs";

const ROUTE = "/api/sgauth/admin/users/import/preview";

// The logic lives in src/lib/user-import; this file only binds it.
export const POST = (request: NextRequest) =>
  withRequestLogging(ROUTE, liveUserImportHandlers.preview, logger)(request);
