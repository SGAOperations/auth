import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { withAuthRateLimit } from "@/lib/rate-limit/server";

const handlers = toNextJsHandler(auth);
const ROUTE = "/api/auth/[...all]";

// Rate limiting sits inside request logging, so a 429 is logged too.
export const GET = withRequestLogging(
  ROUTE,
  withAuthRateLimit(handlers.GET),
  logger,
);
export const POST = withRequestLogging(
  ROUTE,
  withAuthRateLimit(handlers.POST),
  logger,
);
