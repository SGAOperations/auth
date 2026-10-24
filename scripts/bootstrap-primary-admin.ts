import "dotenv/config";
import pg from "pg";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "../src/generated/prisma/index.js";
import {
  BootstrapRefusedError,
  bootstrapInTransaction,
  formatBootstrapSummary,
  parseBootstrapArgs,
  planBootstrap,
  readBootstrapState,
} from "../prisma/seed/bootstrap-primary-admin.js";
import {
  UsageError,
  describeTarget,
  parseSyncEnv,
} from "../prisma/seed/sync-env.js";

// Promotes an existing, verified account to the first Primary Admin. Standalone
// ops script, like scripts/positions-sync.ts: it parses its own env and builds
// its own client. Dry run by default; `--apply` writes. It refuses whenever any
// Primary Admin exists, so it can never write twice. Holding the production
// DIRECT_URL is the authorization. See docs/runbooks/launch-checklist.md.

const USAGE =
  "Usage: npm run bootstrap-primary-admin -- --email <address> [--apply]";

async function main() {
  const { email, apply } = parseBootstrapArgs(process.argv.slice(2));
  const env = parseSyncEnv(process.env);

  console.log(
    `Target: ${describeTarget(env.DIRECT_URL)} (SGAUTH_ENV=${env.SGAUTH_ENV})`,
  );

  const pool = new pg.Pool({ connectionString: env.DIRECT_URL });
  const prisma = new PrismaClient({ adapter: new PrismaPg(pool) });
  try {
    // Refuses here, before any write.
    const plan = planBootstrap(await readBootstrapState(prisma, email), email);
    console.log(formatBootstrapSummary(email, plan));

    if (!apply) {
      console.log(
        `Dry run. Re-run with --apply to make ${email} the Primary Admin.`,
      );
      return;
    }

    await prisma.$transaction((tx) => bootstrapInTransaction(tx, email), {
      timeout: 30_000,
      maxWait: 15_000,
    });
    console.log(
      `Done. ${email} is the Primary Admin. Sign in again and enrol MFA.`,
    );
  } finally {
    await prisma.$disconnect();
  }
}

main().catch((error) => {
  if (error instanceof UsageError) {
    console.error(`${error.message}\n${USAGE}`);
  } else if (error instanceof BootstrapRefusedError) {
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
  process.exitCode = 1;
});
