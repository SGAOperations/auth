import { toNextJsHandler } from "better-auth/next-js";
import { auth } from "@/lib/auth/server";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

const handlers = toNextJsHandler(auth);
const ROUTE = "/api/auth/[...all]";

export const GET = withRequestLogging(ROUTE, handlers.GET, logger);
export const POST = withRequestLogging(ROUTE, handlers.POST, logger);
