import { createInterface } from "node:readline/promises";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  RESET_MFA_PHRASE,
  TRANSFER_PHRASE,
  USAGE,
  UsageError,
  parseRecoveryArgs,
  parseRecoveryEnv,
  phraseMatches,
} from "../src/lib/break-glass/cli";
import {
  buildRecoveryEmail,
  createResendSender,
} from "../src/lib/break-glass/notify";
import {
  RecoveryRefusal,
  RecoveryStateChanged,
  applyRecovery,
  formatRecoveryPlan,
  planRecovery,
  readRecoveryState,
  verifyRecovery,
} from "../src/lib/break-glass/recovery";
import { describeTarget } from "../prisma/seed/sync-env.js";

// Break-glass Primary Admin recovery. Standalone ops script, like
// scripts/positions-sync.ts: it parses its own env and builds its own client.
// There is no HTTP path; holding the production DIRECT_URL and typing the
// confirmation phrase at a terminal is the authorization. Deliberately does not
// load .env, so a stray local DIRECT_URL can never be used by accident.
// See docs/runbooks/break-glass.md.

const RUNBOOK = "docs/runbooks/break-glass.md";

// 0 everything succeeded, 1 refused or failed with nothing written, 2 the
// change committed but verification or a notification failed.
type ExitCode = 0 | 1 | 2;

// Set once the transaction resolves, so a later throw is reported as
// committed-but-failed (exit 2) rather than as nothing written.
let committed = false;

async function confirm(phrase: string): Promise<boolean> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  try {
    return phraseMatches(
      await rl.question(`Type ${phrase} to continue: `),
      phrase,
    );
  } finally {
    rl.close();
  }
}

async function main(): Promise<ExitCode> {
  const args = parseRecoveryArgs(process.argv.slice(2));
  const env = parseRecoveryEnv(process.env, { dryRun: args.dryRun });

  console.log(
    `Target: ${describeTarget(env.DIRECT_URL)} (SGAUTH_ENV=${env.SGAUTH_ENV})`,
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    const plan = planRecovery(
      await readRecoveryState(prisma, args.email),
      args,
    );
    console.log(formatRecoveryPlan(plan));

    if (args.dryRun) {
      console.log("Dry run. Nothing was written.");
      return 0;
    }
    if (!process.stdin.isTTY) {
      throw new RecoveryRefusal(
        "The confirmation phrase must be typed at a terminal.",
      );
    }
    const phrase =
      args.mode === "transfer" ? TRANSFER_PHRASE : RESET_MFA_PHRASE;
    if (!(await confirm(phrase))) {
      console.log("Confirmation phrase did not match; nothing was written.");
      return 1;
    }

    const result = await prisma.$transaction(
      (tx) => applyRecovery(tx, args, plan),
      { timeout: 30_000, maxWait: 15_000 },
    );
    committed = true;
    console.log(`Committed. Audit event ${result.auditEventId}.`);
    console.log(`Sessions signed out: ${result.sessionsRevoked}.`);

    let exitCode: ExitCode = 0;

    try {
      const verified = await verifyRecovery(prisma, result);
      console.log(
        `Verified: exactly one Primary Admin (${verified.primaryAdminEmail}).`,
      );
    } catch (error) {
      exitCode = 2;
      console.error(
        `Verification failed: ${error instanceof Error ? error.message : "unknown error"}`,
      );
    }

    if (env.email) {
      const send = createResendSender({ ...env.email, fetch });
      const results = await send(
        result.recipients,
        buildRecoveryEmail(result.mode, {
          primaryAdminEmail: result.primaryAdminEmail,
          previousPrimaryAdminEmail: result.previousPrimaryAdminEmail,
          operator: args.operator,
          reason: args.reason,
          at: new Date(),
        }),
      );
      const ok = results.filter((r) => r.status === "ok").map((r) => r.to);
      const failed = results
        .filter((r) => r.status === "failed")
        .map((r) => r.to);
      const parts = [
        ok.length > 0 ? `${ok.join(", ")} (ok)` : null,
        failed.length > 0 ? `${failed.join(", ")} (FAILED)` : null,
      ].filter((part) => part !== null);
      console.log(`Notified: ${parts.join("; ")}`);
      if (failed.length > 0) {
        exitCode = 2;
        console.error(
          `Some notifications failed. Email those addresses by hand (${RUNBOOK}).`,
        );
      }
    }
    return exitCode;
  } finally {
    await prisma.$disconnect();
  }
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error) => {
    if (error instanceof UsageError) {
      console.error(`${error.message}\n${USAGE}`);
    } else if (
      error instanceof RecoveryRefusal ||
      error instanceof RecoveryStateChanged
    ) {
      console.error(error.message);
    } else {
      // Never console.error the raw error: some carry connection strings or the
      // offending input, and DIRECT_URL holds the migration role's password.
      console.error(
        error instanceof Error
          ? `${error.name}: ${error.message}`
          : "Unexpected error",
      );
    }
    if (committed) {
      console.error(
        `The change was committed; verify and notify by hand (${RUNBOOK}).`,
      );
      process.exitCode = 2;
    } else {
      console.error("Nothing was written.");
      process.exitCode = 1;
    }
  },
);
