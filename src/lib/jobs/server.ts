import "server-only";
import { recordOpsSignal } from "@/lib/alerts/signals";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { withRequestLogging } from "@/lib/log/request";
import { createJobHandler, type JobRun } from "@/lib/jobs/handler";

/** The route handler for `POST /api/jobs/<name>`, guarded by CRON_SECRET. */
export function jobRoute(name: string, run: JobRun) {
  return withRequestLogging(
    `/api/jobs/${name}`,
    createJobHandler({
      name,
      run,
      secret: env.CRON_SECRET,
      log: logger,
      // The alerts job reports a failed run on its next tick, and so does it
      // for its own failures.
      onFailure: (job) =>
        recordOpsSignal({ kind: "JOB_FAILED", detail: { job } }),
    }),
    logger,
  );
}
