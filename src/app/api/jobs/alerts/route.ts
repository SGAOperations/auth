import { runSecurityAlerts } from "@/lib/alerts/run";
import { mailer } from "@/lib/email/server";
import { jobRoute } from "@/lib/jobs/server";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

// POST only, like every job: it claims AlertState rows. Guarded by CRON_SECRET,
// called by .github/workflows/scheduled-jobs.yml every 15 minutes.
export const POST = jobRoute("alerts", () =>
  runSecurityAlerts({ db: prisma, mailer, log: logger }),
);
