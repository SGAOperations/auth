import { runHealthChecks } from "@/lib/health/checks";
import { probes } from "@/lib/health/probes";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";

// pg (TCP) needs the Node runtime; the verdict must never be cached.
export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const HEADERS = { "Cache-Control": "no-store" };

// Public, read-only, takes no input and ignores the query string. Exempt from
// the preview gate (preview-gate.ts) so an uptime monitor can reach it.
export const GET = withRequestLogging(
  "/api/health",
  async () => {
    const { status, body } = await runHealthChecks(probes, logger);
    return Response.json(body, { status, headers: HEADERS });
  },
  logger,
);

// A monitor that probes with HEAD gets the same verdict, without a body.
export const HEAD = withRequestLogging(
  "/api/health",
  async () => {
    const { status } = await runHealthChecks(probes, logger);
    return new Response(null, { status, headers: HEADERS });
  },
  logger,
);
