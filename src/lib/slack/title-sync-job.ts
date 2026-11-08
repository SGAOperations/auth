import "server-only";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { parseDryRun } from "@/lib/retention/request";
import { runSlackTitleSync } from "@/lib/slack/title-sync";

/** The body of `POST /api/jobs/slack-titles`. */
export async function runSlackTitleSyncJob(request: Request) {
  const dryRun = parseDryRun(request);
  const teamId = env.SLACK_TITLE_SYNC_TEAM_ID;
  // Off unless set, and then without touching the database, so a scheduled run
  // where it is off costs no Neon compute (ENGINEERING §2).
  if (teamId === undefined) return { disabled: true };

  const report = await runSlackTitleSync({
    db: prisma,
    teamId,
    dryRun,
    log: logger,
  });
  if (report.errors > 0) {
    // Thrown so the Actions run turns red and the alerts job reports it. The
    // work that did succeed has already committed. Counts only in the log.
    logger.error("[ALERT] slack title sync had errors", { ...report });
    throw new Error("slack title sync step failed");
  }
  return report;
}
