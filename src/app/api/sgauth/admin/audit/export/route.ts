import { apiError, requireAdmin } from "@/lib/admin-api";
import { audit } from "@/lib/audit";
import {
  AUDIT_TIME_ZONE,
  auditLogFilterSchema,
  buildAuditWhere,
  exportAuditCsv,
  paramsToRecord,
  resolveUserFilter,
} from "@/lib/audit-log";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { prisma } from "@/lib/prisma";
import { limitRequest } from "@/lib/rate-limit/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to about 50 batched queries plus their lookups.
export const maxDuration = 60;

const ROUTE = "/api/sgauth/admin/audit/export";

function fileStamp(now: Date): string {
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: AUDIT_TIME_ZONE,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    })
      .formatToParts(now)
      .map((part) => [part.type, part.value]),
  );
  return `${parts.year}${parts.month}${parts.day}-${parts.hour}${parts.minute}`;
}

async function exportCsv(request: Request) {
  // Reads only, so no mutation limit; the export has its own policy below.
  const guard = await requireAdmin({ mutation: false, action: "accessAdmin" });
  if ("response" in guard) return guard.response;
  const { actor } = guard;

  const limited = await limitRequest("adminExport", actor.id);
  if (limited) return limited;

  // A `cursor` param is ignored: an export always starts at the newest row.
  const parsed = auditLogFilterSchema.safeParse(
    paramsToRecord(new URL(request.url).searchParams),
  );
  if (!parsed.success) {
    return apiError(400, "INVALID_INPUT", "Invalid filter.");
  }
  const filter = parsed.data;

  // An email that matches no user is not an error: it exports the header row
  // only, like the empty table the page shows.
  const user = filter.user
    ? await resolveUserFilter(prisma, filter.user)
    : undefined;
  const where = buildAuditWhere(filter, user?.id ?? null);

  // Fails closed: if this throws, nothing is streamed. No filter values are
  // recorded, because a user filter is an email address.
  await audit(
    { type: "AUDIT_EXPORTED", actorType: "USER", actorUserId: actor.id },
    { db: prisma, headers: request.headers },
  );

  const iterator = exportAuditCsv(prisma, where);
  const encoder = new TextEncoder();
  let chunksSent = 0;
  const body = new ReadableStream<Uint8Array>({
    async pull(controller) {
      try {
        const next = await iterator.next();
        if (next.done) {
          controller.close();
          return;
        }
        chunksSent += 1;
        controller.enqueue(encoder.encode(next.value));
      } catch {
        // Never log the error or the filter: both can carry an email address.
        logger.error("Audit export failed", { chunksSent });
        controller.error(new Error("Audit export failed"));
      }
    },
    async cancel() {
      await iterator.return(undefined);
    },
  });

  return new Response(body, {
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="sgauth-audit-${fileStamp(new Date())}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

export const GET = withRequestLogging(ROUTE, exportCsv, logger);
