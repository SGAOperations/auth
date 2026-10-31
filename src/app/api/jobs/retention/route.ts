import { jobRoute } from "@/lib/jobs/server";
import { runRetentionJob } from "@/lib/retention/server";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
// Up to 150 tombstones, each its own transaction, plus the notices.
export const maxDuration = 60;

// POST only: the job changes state. Guarded by CRON_SECRET, called daily by
// .github/workflows/scheduled-jobs.yml. `?dryRun=1` writes nothing.
export const POST = jobRoute("retention", runRetentionJob);
