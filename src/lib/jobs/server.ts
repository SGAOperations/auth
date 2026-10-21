import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { createJobHandler, type JobRun } from "@/lib/jobs/handler";

/** The route handler for `POST /api/jobs/<name>`, guarded by CRON_SECRET. */
export function jobRoute(name: string, run: JobRun) {
  return withRequestLogging(
    `/api/jobs/${name}`,
    createJobHandler({ name, run, secret: env.CRON_SECRET, log: logger }),
    logger,
  );
}
