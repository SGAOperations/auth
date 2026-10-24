import { jobRoute } from "@/lib/jobs/server";
import { runPaTransferJob } from "@/lib/jobs/pa-transfer";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only: the job changes state. Guarded by CRON_SECRET, called by
// .github/workflows/scheduled-jobs.yml.
export const POST = jobRoute("pa-transfer", () => runPaTransferJob());
