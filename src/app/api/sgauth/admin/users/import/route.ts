import type { NextRequest } from "next/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { liveUserImportHandlers } from "@/lib/user-import/server";

export const runtime = "nodejs";
// Up to 1,000 rows in one transaction, then up to 50 paced invite emails.
export const maxDuration = 60;

const ROUTE = "/api/sgauth/admin/users/import";

// The logic lives in src/lib/user-import; this file only binds it.
export const POST = (request: NextRequest) =>
  withRequestLogging(ROUTE, liveUserImportHandlers.apply, logger)(request);
