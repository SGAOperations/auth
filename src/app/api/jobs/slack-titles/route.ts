import { jobRoute } from "@/lib/jobs/server";
import { runSlackTitleSyncJob } from "@/lib/slack/title-sync-job";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// The sync stops itself at 35 seconds, leaving room for the last person.
export const maxDuration = 60;

// POST only: the job changes state. Guarded by CRON_SECRET, called daily by
// .github/workflows/scheduled-jobs.yml. `?dryRun=1` writes nothing. Does nothing
// unless SLACK_TITLE_SYNC_TEAM_ID is set.
export const POST = jobRoute("slack-titles", runSlackTitleSyncJob);
