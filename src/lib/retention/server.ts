import "server-only";
import { toAuthSettings } from "@/lib/auth/settings";
import type { Mailer } from "@/lib/email/mailer";
import { env } from "@/lib/env";
import { logger } from "@/lib/log";
import { prisma } from "@/lib/prisma";
import { runRetention, type RetentionReport } from "@/lib/retention/job";
import { parseDryRun } from "@/lib/retention/request";
import { plainLinkUrl } from "@/lib/token-links/actions";

// Loaded on the first notice: the mailer reads the whole environment, and a
// run with nobody to notify never needs it.
const mailer: Pick<Mailer, "sendEmail"> = {
  async sendEmail(message) {
    const { sendEmail } = await import("@/lib/email/server");
    return sendEmail(message);
  },
};

/** The body of `POST /api/jobs/retention`. */
export async function runRetentionJob(
  request: Request,
): Promise<RetentionReport> {
  const dryRun = parseDryRun(request);
  const origin = new URL(toAuthSettings(env).baseURL).origin;
  const report = await runRetention({
    db: prisma,
    mailer,
    signInUrl: plainLinkUrl(origin, "sign-in"),
    now: new Date(),
    dryRun,
  });
  if (report.errors > 0) {
    // Thrown so the Actions run turns red and the alerts job reports it. The
    // work that did succeed has already committed. Counts only in the log.
    logger.error("[ALERT] retention job had errors", {
      errors: report.errors,
      dryRun: report.dryRun,
      tombstoned: report.tombstoned,
      notices: report.notices,
      purged: report.purged,
      anonymizedAuditRows: report.anonymizedAuditRows,
    });
    throw new Error("retention step failed");
  }
  return report;
}
